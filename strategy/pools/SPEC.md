# Strategy page — PEX liquidity provision

**Status:** written 2026-10-20. **The read-only design below is DELIVERED and
then superseded.** All three destinations now take deposits and withdrawals
signed in our own UI — see [`OVERVIEW.md`](./OVERVIEW.md) for current status and
[`SIGNING.md`](./SIGNING.md) for how, including §11, which is the list of claims
this document and that one both got wrong before MainNet corrected them.

> **What changed, and why this file is kept anyway.** §7.1 chose to link out to
> Ultrade to deposit. That was wrong for the brief, not merely minimal, and the
> URL it chose did not exist. §7.2 and §12 planned the signing work; it is built.
> The product reasoning in §§1-6 — what is shown, what is deliberately NOT
> claimed, and the corrected open-interest and APR language — is still live and
> still governs the page, which is why this is amended rather than replaced.
> `/strategy` joined the nav on 2026-10-23, once the C-Vault had a full signed
> round trip and the two direct pools went admin-gated. See OVERVIEW.md.
**Scope:** self-managed liquidity provision into PEX's three capital destinations.
**Explicitly out of scope:** "Smart Stake" / Magnet-managed fund — shelved by decision 2026-10-20.

---

## 1. Why this exists

> ⚠️ **Corrected 2026-10-20 after audit.** The paragraph below originally said
> "open interest is capped by the capital sitting in PEX's pools", and the page
> told users a deposit "raises the ceiling for every trader". **That is false.**
> OI is capped by two separate things: a per-market `max_open_interest_long/short`
> **risk parameter PEX's admin sets** (`market_risk` words 4/5), and a
> pool-derived reserve check. A deposit moves the second and cannot touch the
> first. Verified on chain: market 1 sat at **$2,195.60 of a $2,200.00 cap** —
> $4.40 of headroom — so a $10,000 deposit would have bought $4.40 of tradable
> size. The page now states this and shows each market's cap and utilisation.

Trading size on `/trade` is bounded by open interest, and one of the two
constraints on it is the capital sitting in PEX's pools. Those pools are currently **~$4,786 in total**, so
the OI ceiling is the binding constraint on nearly every trade the terminal can
place — `MAX_PLAUSIBLE_NOTIONAL_USD` is 25,000 against a market-1 pool of ~$2,600.

This page lets a user add that capital. It is the supply side of a product whose
demand side already ships.

**We custody nothing.** Same posture as the Trading Terminal: we construct
transactions against a third-party protocol, the user signs them, and the capital
goes to PEX. No Magnet contract sits in the path. That is what keeps this
shippable without a new audited contract.

---

## 2. Route: `/strategy`

The page lives at `/strategy` and the nav label is "Strategy".

This spec originally argued for `/liquidity`, because `/strategy` was a
**permanent (301) redirect to `/trade`** — the trading terminal's former name.
That redirect is removed and the page owns the path, which is what the product
is called.

**The one residual risk, stated rather than buried.** Browsers cache 301s
indefinitely, so anyone who visited `/strategy` before 2026-10-20 keeps landing
on `/trade` until their cache expires, and nothing we ship can clear it. That
population is whoever hit a path which existed only as an internal rename, so it
is close to empty — and where they land is a working page, not an error. Weighed
against a permanent mismatch between the product's name and its URL, this is the
better trade.

**Components live under `src/components/strategy/pools/`**, mirroring this
document's own path. They were at `src/components/liquidity/` until 2026-10-27,
which inverted against `src/components/strategy/` holding the *terminal* — so
`StrategySplash.tsx` sat in `liquidity/` while `TradeSplash.tsx` sat in
`strategy/`, each named for the page the other directory served.

**Paths still consumed by legacy redirects**, none available: `/earn`, `/pools`,
`/dao`, `/vote`, `/token`, `/musd`.

### 2.1 Page chrome

The root layout renders **no navbar** — every route supplies its own
`layout.tsx` (`contact`, `magnetfi`, `predict`, `trade`, `tokens` all do). The
first build of this page shipped a `page.tsx` with no layout, so it rendered
with no navigation at all and no way off it but the back button.
`src/app/strategy/layout.tsx` is required, not optional.

### 2.2 Splash and tabs

- **Splash**: `StrategySplash`, the fourth `ArrivalSplash`, using the house
  banner (`/magnet-wordmark-tight.png`) rather than a product mark. /tokens
  leads with the $U mark and /magnetfi with its wordmark because each stands for
  one asset or protocol; Strategy is a shelf, so it carries the organisation's
  own mark. Mounted as a SIBLING of the content — an ancestor running an opacity
  animation becomes a backdrop root and the blur silently does nothing.
- **Tabs**: a pill segmented control matching Finance and Tokens, one tab
  ("Pools") today. A real track rather than a heading, because a track gains its
  second tab in one line and a heading becomes a rewrite.

## 3. What PEX actually offers

Three capital **destinations**, reached by three **methods**. Destinations are the
UI axis; the methods are plumbing.

| Destination | App | Deposit method | SDK builder | Quote |
|---|---|---|---|---|
| **C-Vault** | `PDexV2CvaVault` `3690309167` | `deposit(txn,txn,pay,uint64,…)` | `buildV2CvaDepositTransactions` | `quoteV2CvaDeposit`, `quoteV2CvaNav` |
| **ALGO/USD pool** (market 1) | `PDexV2AdminOps` `3690309162` | `deposit_liquidity(market_id,…)` | `buildV2DepositLiquidityTransactions` | `quoteV2LpDeposit`, `quoteV2LpNavV1` |
| **BTC/USD pool** (market 2) | same | same | same | same |

A fourth entry point exists and is **not a fourth destination**:
`PDexV2SingleTokenOps.deposit_liquidity_single` is an alternative *door* into the
same two market pools, taking one asset instead of two.

### 3.1 Both markets are ALGO-long / USDC-short

Read from `market_core` (`m2:` boxes on the markets app):

```
market 1 (ALGO/USD)  index=ALGO              LONG=ALGO  SHORT=USDC  type=1
market 2 (BTC/USD)   index=synthetic BTC     LONG=ALGO  SHORT=USDC  type=2
```

So **BTC/USD contains no BTC.** You take BTC exposure by backing it with ALGO and
USDC. This must be said on the card — it is the single most surprising fact on the
page and the easiest way for someone to misunderstand what they bought.

Consequence: a "deposit USDC" form is wrong for the direct-LP route, which needs
both legs. See §7.

### 3.2 The two apps that look like LPs and are not

`marketYieldVault` `3690309168` and `marketXAlgoYieldVault` `3690309169` have
**no deposit or withdraw methods at all** (14 methods each, none user-facing).
They are destinations for PEX's *idle market cash* via `yield_send_to_vault_raw`,
which is keeper/admin. Do not wire them. This is the same yield-recall machinery
the terminal's close path already handles.

### 3.3 Permissionless — verified, not assumed

The `AdminOps` name suggests otherwise, so this was checked on chain:

- **6 distinct market-LP addresses** across the two markets (`ml2:` boxes)
- **7 C-Vault depositors** (`gu2:` boxes)
- the PEX creator `C5IKAFRG…` is **not** among the LP holders
- 3 addresses appear in both sets

Third parties are already using both routes.

---

## 4. Data layer

### 4.1 Reads

All from algod boxes — no PEX API call anywhere, consistent with the terminal's
existing posture (its manifest is vendored and hash-pinned; the only third-party
HTTP in the signing path is the oracle bundle, which is signature-verified).

| What | Where | Prefix |
|---|---|---|
| market asset legs, type | markets `3690309159` | `m2:` |
| pool amounts, fees, share supply | markets | `mp2:` |
| a user's LP position | markets | `ml2:` + marketId(8B) + addr(32B) |
| C-Vault user shares | cvaVault `3690309167` | `gu2:` + addr |
| C-Vault market allocations | cvaVault | `gm2:` |

### 4.2 The deduplication rule — load-bearing

**The C-Vault's capital lives inside the market pools.** It holds LP shares in both:

```
market 1   993.907 shares of 2,350.4244   = 42.3%   mark $1,137.64
market 2   431.138 shares of 1,934.2846   = 22.3%   mark   $487.58
```

So a "total liquidity" figure must **not** sum pool values plus C-Vault NAV. It is
already counted:

```
total capital backing OI    ~$4,786
  ├─ direct LPs             ~$3,160
  └─ via the C-Vault        ~$1,626
```

Summing naively gives ~$6,400 — wrong by a third, on the one number the page
exists to make credible. This gets a test.

---

## 5. APR — PEX's feed, not our derivation

**Superseded 2026-10-21.** Ultrade published the daily pool-statistics bundle
the day after this spec was written, and SDK 0.6.10 added
`loadPoolPerformanceBundleFromR2`. The page now reads PEX's own figures.

### 5.1 Why our derivation was removed, not refined

It was wrong, and wrong in the direction this spec claimed it was not:

| | derived | PEX fee APR | PEX yield APR | **PEX total** |
|---|---|---|---|---|
| ALGO/USD | 15.3% | 4.83% | 6.39% | **11.22%** |
| BTC/USD | 0.88% | 0.00% | 6.14% | **6.14%** |
| C-Vault | 11.0% | 2.79% | 6.29% | **9.08%** |

Two independent errors, compounding:

1. **Inception average, not a current rate.** It annualised fees since the
   pool opened. Trading has since slowed **4.1x** — $1.088/day over the first
   48.9 days against $0.268/day over the last seven — so the figure overstated
   what a depositor would earn today by **3.2x**. §5.3 of this spec argued the
   derivation "errs low". That was true of the historical realised rate and
   false of the current one, which is the only one a prospective depositor acts
   on.
2. **It omitted yield income**, which on these pools is the LARGER half
   (6.39% against 4.83% on ALGO/USD). BTC/USD earns 6.14% with zero trading at
   all, so a fee-only page called a working pool worthless.

The arithmetic is deleted rather than deprecated, so it cannot be reached for
again. `MarketLiquidity.feesSinceInceptionUsd` keeps the cumulative fee total,
which is a true stock.

### 5.2 What the page shows

- **Headline: `total_apr_7d_bps`**, labelled "Fees + yield APR (past 7d)" —
  PEX's own wording — with the fee/yield split beneath.
- **Beneath it: `vs_holding_bps`**, the pool's return against a benchmark of
  holding the two assets. This is the genuinely useful number: it **includes**
  trader P&L, which the APR explicitly excludes. Negative means holding would
  have beaten depositing.

### 5.3 Rules taken from PEX's own guidance, each one tested

- `bps / 100` for a percentage — 1250 is 12.5%, not 0.125%.
- Display the APR **only** when `apr_status === "ready"` **and**
  `apr_basis === "historical_capital_v1"`. Anything else is unavailable, never 0%.
- `insufficient_history` / `no_valid_completed_samples` are valid RESULTS to
  surface as "Insufficient history", and a `reason` wins even if points are
  present.
- Fewer than two points is insufficient history.
- `vs_holding_bps` is additive percentage **points**, not a ratio.
- The paired benchmark is `geometric_mean_50_50` and is **not** buy-and-hold —
  one asset doubling while the other is flat gains ~41.42%, not 50% — so it is
  labelled "vs 50/50 geometric benchmark", never "vs holding".
- `expires_at` is 36h after the cutoff; an expired bundle is shown **with its
  date and a stale label**, not hidden and not zeroed.
- A 404 is not zero performance.
- Never add the APR to the period return; never call either APY.

### 5.4 The trust model, which differs from everything else on the site

PEX documents this feed as **unsigned**, "trusted through HTTPS/storage
delivery", and states that `manifest_sha256` "identifies the deployment
context; it is not a signature or integrity proof for the data". Our oracle
bundle *is* signed and the terminal verifies it per-payload; this cannot be.

That is acceptable because **nothing here reaches a transaction** — these
figures are displayed, never signed against. It is not acceptable to present
them as equal in confidence to a chain read, so: the UI attributes them to PEX,
says plainly that they are unsigned while the price feed is verified, and the
envelope checks (network, type, self-declared path, expiry) are the only
integrity available. Pool sizes, composition and the viewer's own position
remain chain reads and do not depend on the feed.

Asking Ultrade to sign it remains worthwhile and was declined for now.

### 5.5 Why the bundle is fetched here rather than via the SDK

`vendor/README.md` is explicit — *"Do not bump this in isolation"*:
`PEX_SDK_VERSION`, the pinned program hashes and the solver verification all
move with the SDK, and the closed-form solver is checked against
`quoteV2OpenPosition`. Bumping 0.6.6 → 0.6.10 to read a JSON file would put the
terminal's trading maths in scope for a liquidity-page feature. The loader is a
fetch plus validation, reimplemented in `strategy/performance.ts` against the same
documented contract, with a captured real response as a test fixture.

## 6. Styling

Reuse the Finance page's language exactly — `Panel`, `PrimaryButton`,
`collateralGlow`'s shadow strings, Inter + JetBrains Mono, the `#08000f` ground.

**All three cards carry `MAGNET_GLOW` (purple).** No gold.

This is correct for a reason worth recording, not just a preference: on the Finance
page gold means *"this collateral is not $U"* — it marks a different risk family.
Here **all three destinations hold the same collateral** (ALGO + USDC), so a gold
card would assert a distinction that does not exist. An early mockup used gold for
the ALGO market and was wrong for exactly that reason.

---

## 7. Deposit flows

### 7.1 v1: link out — SUPERSEDED and REMOVED, see §12 and SIGNING.md

> ⚠️ **This decision was wrong for the brief.** The point of the page is to let
> someone deposit through Magnet Strategies; handing them to Ultrade's app to
> finish is a different product. Kept here because the risk reasoning below is
> still the reason §12 is sized the way it is, not because the conclusion
> stands.

~~**v1 does not build deposit transactions.**~~ (All three now do — §12.)
Each card's action links out to
Ultrade's app.

> ⚠️ **URL was fabricated.** The first build used `https://pex.ultrade.org`,
> which **does not exist** — no DNS record of any type, HTTP fails to resolve. I
> invented the hostname and nothing in the repo referenced a PEX frontend to
> check it against, so every call-to-action on the page pointed at a browser
> error. Now `https://app.ultrade.org`, verified HTTP 200. **Still open:** that
> is Ultrade's app host, not a confirmed PEX liquidity deep link, so all three
> cards point at the same place and "destination preselected" is unmet.

Rationale: the three deposit groups are materially more complex than the perps
groups we already sign — two asset legs, storage payments, `min*Shares` slippage
bounds, and a yield-recall preamble on the market routes. `perpsGroup.ts` is 2,200
lines of assertion for four group shapes; three more shapes is not a small
addition, and it is the part that moves user funds.

Shipping the **read layer plus honest APRs plus a link** delivers most of the value
at a fraction of the risk, and tells us whether anyone actually deposits before we
build signing for it.

### 7.2 v2: construct, if v1 shows demand

If we do build it, the asset shape forces the form design:

- **Direct LP** — two-asset form (ALGO + USDC), `minMarketShares` bound required.
- **Single-token** — one-asset form, *if* either live market exposes it. `singleToken`
  is a derived flag in the read model, not a field in `market_core`; **unresolved**.
  If both markets are false, there is no single-asset route and every form is
  two-asset.
- **C-Vault** — two-asset form, no market selection, `minCvaShares` bound.

Every one of these would go through the same display-vs-signed assertion discipline
as `perpsGroup.ts`, or not ship.

---

## 8. Out of scope for v1

- Deposit/withdraw transaction construction (§7.1)
- Withdrawals of any kind
- "Smart Stake" / Magnet-managed fund — shelved
- Position management, compounding, auto-rebalance
- Anything touching `marketYieldVault` / `marketXAlgoYieldVault` (§3.2)

---

## 9. Open questions

1. **`singleToken` per market** — decides whether a USDC-only form is possible at
   all. One live read of a market record. Blocks §7.2, not v1.
2. **Nav label** — "Strategy" or "Liquidity". Branding, not technical.
3. **Launch share price** — is it 1.00? Determines whether §5.2's implied return is
   real. Affects a stat, not the headline.

---

## 10. Test plan

Behaviour, asserted on values — not greps:

1. **Dedup invariant**: total liquidity ≠ Σ(pool values) + CVA NAV. A test that
   fails if someone sums naively.
2. **CVA ownership**: CVA share holdings ÷ pool share supply, per market, against
   the marks.
3. **Fee-yield arithmetic**: annualisation from (fees, pool value, days) with a
   fixed clock, including the zero-fee and zero-pool cases.
4. **Asset legs**: both markets report ALGO long / USDC short, so a card can never
   silently claim "deposit USDC only".
5. **No yield-vault wiring**: `3690309168` / `3690309169` appear in no deposit path.
6. **Glow**: all three destinations resolve to `MAGNET_GLOW`.

---

## 11. Reference — live values at time of writing (2026-10-20)

ALGO $0.1134. 50.3 days since 2026-08-31.

```
market 1 (ALGO/USD)   5,717.05 ALGO + 1,952.05 USDC   ~$2,600
                      shares 2,350.4244   NAV/share $1.1064
                      fees 0.6532 ALGO + 53.1041 USDC

market 2 (BTC/USD)    6,700.49 ALGO + 1,425.57 USDC   ~$2,185
                      shares 1,934.2846   NAV/share $1.1299
                      fees 0.4476 ALGO + 2.5136 USDC

C-Vault               NAV ~$1,625   7 depositors
                      70% target ALGO/USD, 30% BTC/USD, bands 0-100%
```

These are a snapshot for sanity-checking the read layer, **not** values to hardcode.

---

## 12. Signing on our own UI — what it takes

> **DELIVERED 2026-10-21/22.** Built for all three destinations.
> [`SIGNING.md`](./SIGNING.md) is the implemented spec and supersedes the
> estimates below. Three of them were wrong in ways worth reading:
> §12.3 called the yield recall a preamble we would need "if" PEX required it —
> it is mandatory on every withdrawal, with non-zero caps on both legs; the
> C-Vault's mark preamble is assembled by the SDK rather than by us; and the
> per-destination group sizes came out at 6 (pool deposit), 10 (pool withdraw),
> 8 (vault deposit) and 15 (vault withdraw).

The page returns to the nav when a deposit can be completed here. Scope, in the
order it has to be built:

### 12.1 Three group shapes

| Destination | Method | Shape |
|---|---|---|
| Direct LP | `deposit_liquidity` | 2 asset transfers (ALGO + USDC) + storage `pay` + `min_market_shares` |
| Single-token | `deposit_liquidity_single` | 1 asset transfer + storage `pay` + `min_market_shares` |
| C-Vault | `CvaVault.deposit` | 2 asset transfers + `pay` + `min_cva_shares` |

SDK builders exist for all three (`buildV2DepositLiquidityTransactions`,
`buildV2SingleTokenDepositLiquidityTransactions`, `buildV2CvaDepositTransactions`)
with matching quote functions, so the construction is not the hard part.

**Still unresolved:** whether either live market exposes the single-token route.
`singleToken` is a derived flag in the read model, not a field in `market_core`.
If both are false there is no one-asset door and every form is two-asset.

### 12.2 The assertion layer — the actual work

`perpsGroup.ts` is ~2,200 lines of field-by-field decode-and-compare for the
terminal's **four** group shapes: every receiver, amount, asset, app arg and
`onComplete` checked against what the screen displayed, with
`ALLOWED_TXN_TYPES` failing anything else by count. Three more shapes need
equivalent treatment or they do not ship — the trade page set that standard and
a liquidity deposit moves more of a user's money in one signature than a perps
open does.

Specifically each shape needs: both anchors on every value-moving leg (equal to
displayed **and** equal to a pinned constant), `flatFee` at `minFee` so
congestion cannot inflate the group, a display-drift guard between quote and
signature as the open path has, and the `SubmissionUnknownError` handling that
makes a dropped response recoverable rather than a silent double-deposit.

### 12.3 Yield-recall preamble

The market routes need `prepareV2ActionRecall` ahead of the deposit, as the
close path already does. Reuses existing code; the caps come from
`v2MarketYieldActionRecallPlan`.

### 12.4 Withdrawals

**A deposit UI without a withdrawal UI is a trap.** The C-Vault has a ~1 hour
cooldown, a 0.2% burn spread and a $5 minimum; the direct pools have their own
cooldown (`quoteV2DirectLpWithdrawCooldown`). Someone who can deposit here and
must leave to withdraw will assume their capital is stuck. Ship both or neither.

### 12.5 What stays as built

The read layer, the dedup logic, the fee APR and its capital-stability
justification, the OI cap display, the splash and the tab bar all stand. Only
the three cards' call-to-action changes.

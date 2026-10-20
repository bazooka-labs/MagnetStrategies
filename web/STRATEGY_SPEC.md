# Strategy page — PEX liquidity provision

**Status:** spec, not built. Written 2026-10-20.
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

**Components stay under `src/components/liquidity/`.** `src/components/strategy/`
still holds the perps components; renaming it would touch the terminal for no
benefit.

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

## 5. APR — the honest treatment

**PEX publishes no APR.** Zero occurrences of `apr`/`apy` anywhere in the SDK's
type surface. `quoteV2LpNavV1` and `quoteV2CvaNav` return NAV, not a rate. Every
rate on this page is therefore **derived by us**, and the derivation must be stated.

### 5.1 What we show

**Fee yield**, annualised from fees accrued on chain since the **first deposit**
into each pool.

> ⚠️ **Date corrected 2026-10-20 after audit.** This said the pools went live
> 2026-08-31, taken from the first transaction on the markets app — which is the
> app's **creation** (2026-08-31T14:55:26Z), not a deposit. The pools sat empty
> for nearly two more days. The first `deposit_liquidity` call is round
> **64,643,818, 2026-09-02T01:29:07Z**. Dating accrual from creation overstated
> the window by 2.06 days and understated every rate by ~4%. The test for this
> was self-confirming — it asserted `poolAgeDays` against the same constant the
> implementation used — and now pins the round's real timestamp instead.

| | fees accrued | % of pool | annualised (corrected) |
|---|---|---|---|
| ALGO/USD | $53.18 | 2.045% | **~15.3%** |
| BTC/USD | $2.56 | 0.117% | **~0.88%** |
| C-Vault | — | — | **~11.0%** (holdings-weighted) |

### 5.2 What we do NOT show as the headline

> ⚠️ **Relabelled 2026-10-20 after audit.** What this spec and the first build
> called "NAV/share" is pool value ÷ shares, which is **not** PEX's NAV per
> share: PEX's includes trader P&L, lent quantity and the position-impact pool.
> It was 2.4% low when checked (1.1063 shown vs ~1.1334 true) **and the sign
> flips** — with traders up it would read high, on the one stat a depositor uses
> to judge whether LPs have earned. Renamed `poolValuePerShare` and labelled
> "Pool / share" in the UI. The copy claiming "share prices above $1.00 mean
> traders have been losing" is removed: the figure contains no trader P&L, so it
> was not evidence of that.

Pool value per share is $1.1064 and $1.1299. Against a $1.00 launch that is +10.6% and +13.0%
in 50 days — ~77% and ~94% annualised. Those numbers are **much larger and much
more misleading**, because an LP here is the counterparty to every trade:

> **LP return = fees + trader P&L**, and the second term dominates and can be negative.

Market 2 earned **$2.56** of fees while its share price rose **13%**. Essentially
all of that is traders losing. It can invert. A card reading "94% APR" would be the
most misleading element on the site.

So: fee yield is the headline, NAV/share is shown as a stat, and the page carries an
explicit note that neither is an expected return.

### 5.3 Caveats that must appear in the UI, not just here

1. Assumes **today's** pool size across the whole period. If pools grew, the real
   yield was higher; if they shrank, lower.
2. Excludes any fees already withdrawn — these are current accrued balances, so
   it is a floor.
3. The $1.00 launch share price is an **assumption**, not verified.

### 5.4 Not derivable, do not attempt

`cva_market_allocation.last_deposit_mark_value_usd` resets on every deposit (the
live mark was taken 0.0 days ago), so "return since deposit" is noise over minutes,
not a performance figure. It read −0.06% and −0.04% when checked.

---

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

### 7.1 v1: link out, do not construct

**v1 does not build deposit transactions.** Each card's action links out to
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

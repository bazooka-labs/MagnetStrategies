# MagnetFi v2 — LP Oracle

## Purpose

The LP oracle values Tinyman LP positions in mUSD (≈ USDC). It does not price individual assets — it prices LP tokens directly as a share of their underlying pool value. Vaults read LP token prices to compute borrower LTVs and health factors.

---

## Why LP Pricing Is Different from Spot Pricing

In v1, the oracle posts a single $U/USDC price. In v2, the oracle must price LP tokens — which represent a proportional share of two assets in a pool that changes with every swap.

An LP token's value is not observable from a single price feed. It requires:
1. The current pool reserves (how much of each asset the pool holds)
2. The total LP token supply (what fraction the holder owns)
3. The USD value of each underlying asset

Flash loan attacks and pool manipulation within a single block can transiently distort pool reserves. The oracle must be resistant to this.

---

## Valuation Formula

```
lp_value_per_token = pool_tvl / total_lp_supply

pool_tvl = (reserve_A × price_A_in_usdc) + (reserve_B × price_B_in_usdc)
```

**Decimal normalization:** pool reserves are in base units. Each asset's base unit count must be divided by its decimal factor before multiplying by its USD price.

```
pool_tvl_usdc = (reserve_A / 10^decimals_A × price_A) + (reserve_B / 10^decimals_B × price_B)
```

For a U/ALGO pool (U has 5 decimals, ALGO has 6 decimals):
```
pool_tvl = (algo_reserves / 1_000_000 × algo_price_usdc) + (u_reserves / 100_000 × u_price_usdc)
lp_price_per_token = pool_tvl / (total_lp_supply / 1_000_000)  [LP tokens have 6 decimals]
```

---

## Oracle Contract

The LP oracle is a separate contract from the v1 price oracle. It stores one price per supported LP pool.

**Global state:**

| Key | Type | Description |
|---|---|---|
| `lp_price_[pool_id]` | uint64 | mUSD value per LP token, scaled to 6 decimal places |
| `lp_last_updated_[pool_id]` | uint64 | Unix timestamp of last successful update per pool |
| `lp_anchor_[pool_id]` | uint64 | Admin-set anchor; posts must stay within ±25% of it (P19-03) |
| `authorized_updater` | bytes | Oracle bot wallet address |
| `admin` | account | Hot admin key (mutable via 2-step rotation); initialized to deployer |
| `guardian` | account | Cold guardian key (admin recovery, guardian rotation) |
| `pending_admin` / `pending_guardian` | account | Proposed roles awaiting acceptance (zero when none) |

**Price representation:** same as v1. 1.00 mUSD per LP token = `1_000_000`. All vault math uses this scaled integer.

**Supported pools (initial):**

| Pool | Pool App ID | Assets |
|---|---|---|
| U/ALGO | TBD | $U + ALGO |
| U/tALGO | TBD | $U + tALGO |
| U/USDC | TBD | $U + USDC |
| U/wBTC | TBD | $U + wBTC (bridged; verify ASA decimal count before deploy — see AUD-006) |

---

## Methods

### Admin Sender Assertion

All admin methods must include as their **first assertion**: `Assert Txn.sender == Global.creator_address`

---

**`update_lp_price(pool_id, new_price)`** — oracle bot wallet only
1. Assert `Txn.sender == authorized_updater`
2. Assert `new_price > 0` — a zero price permanently bricks the pool oracle: if 0 is stored as the initial price, the deviation guard (step 4) then constrains all future posts to `[0 × 50/100, 0 × 150/100] = [0, 0]`, making it impossible to ever post a real price
3. Assert `pool_id` is in supported whitelist
4. Deviation guard vs **prior** — applied only when a prior price exists (`lp_price_[pool_id] != 0`):
   - Lower: `Assert WideRatio(new_price, 100, 50) >= lp_price_[pool_id]` — reject if >50% drop
   - Upper: `Assert WideRatio(new_price, 100, 150) <= lp_price_[pool_id]` — reject if >50% spike
5. Anchor band vs **admin anchor** — applied when `lp_anchor_[pool_id] != 0` (P19-03):
   - Lower: `Assert WideRatio(new_price, 100, 75) >= lp_anchor_[pool_id]` — reject if <−25% of anchor
   - Upper: `Assert WideRatio(new_price, 100, 125) <= lp_anchor_[pool_id]` — reject if >+25% of anchor
   - The prior-guard alone bounds only *per-update* movement; a compromised bot could ratchet it arbitrarily over many posts. The anchor caps **cumulative** drift until the admin re-anchors.
   - Wide math (mulw/divw) required throughout: avoid overflow at large LP prices
6. Store `lp_price_[pool_id] = new_price` and `lp_last_updated_[pool_id] = current_timestamp`

**`get_lp_price(pool_id)`** — read-only; vault reads oracle global state directly via cross-app state reference
- Returns `lp_price_[pool_id]` and `lp_last_updated_[pool_id]`
- Vault must assert `lp_price_[pool_id] > 0` after reading — a never-initialized pool returns 0; the freshness check alone (timestamp=0 ≫ freshness window) is the primary guard but an explicit price > 0 check adds clarity

**`set_authorized_updater(new_address)`** — admin only
1. Assert `Txn.sender == Global.creator_address`
2. Assert `new_address != ZeroAddress` — setting authorized_updater to ZeroAddress permanently bricks the oracle; no price can ever be posted again
3. Update `authorized_updater`

**`add_pool(pool_id, initial_price)`** — admin only
1. Assert `Txn.sender == admin`
2. Assert `pool_id` not already in supported whitelist
3. Assert `initial_price > 0`
4. Add `pool_id` to supported whitelist
5. Store `lp_price_[pool_id] = initial_price`, **`lp_anchor_[pool_id] = initial_price`**, and `lp_last_updated_[pool_id] = current_timestamp`

**Why `initial_price`:** The first bot post for a new pool bypasses the prior-deviation guard (no prior price). Admin sets the initial price under the hardware wallet — stored as both the live price and the drift anchor, so both guards are active from the first bot update, closing the first-post manipulation window (AUD-003).

**`set_price_anchor(pool_id, anchor_price)`** — admin only
1. Assert `Txn.sender == admin`; `anchor_price > 0`; pool is registered
2. Store `lp_anchor_[pool_id] = anchor_price`

**When to re-anchor:** during a genuine large move (beyond ±25%), the bot's posts will hit the anchor band and be rejected. The admin re-anchors under the hardware wallet to follow the real price. This deliberate manual step is the cumulative-drift backstop — a compromised bot key cannot perform it (P19-03).

**Role management:** `deploy(guardian)` sets admin = deployer, guardian = the passed cold key. 2-step rotation via `propose_admin`/`accept_admin` (admin or guardian proposes) and `propose_guardian`/`accept_guardian`.

**`remove_pool(pool_id)`** — admin only
1. Assert `Txn.sender == Global.creator_address`
2. Remove `pool_id` from supported whitelist
3. Clear `lp_price_[pool_id]` and `lp_last_updated_[pool_id]`

**Warning:** removing a pool while active vaults are borrowing against it causes oracle prices to go stale → health liquidations for that vault type are blocked. Admin must verify no active vaults remain for the pool before removing. Add to pre-removal checklist: query all vault boxes for `lp_pool_id == pool_id`; ensure all are closed first.

---

## On-Chain Deviation Guard

Same architecture as v1: contract-level guard is independent of off-chain bot divergence check.

```
# Inside update_lp_price() — enforced by contract
# Applied only when a prior price exists (lp_price[pool_id] != 0)
if lp_price[pool_id] != 0:
    Assert WideRatio(new_price, 100, 50) >= lp_price[pool_id]    # reject if >50% drop vs prior
    Assert WideRatio(new_price, 100, 150) <= lp_price[pool_id]   # reject if >50% spike vs prior
    Assert WideRatio(new_price, 100, 75) >= lp_anchor[pool_id]   # reject if <−25% of anchor
    Assert WideRatio(new_price, 100, 125) <= lp_anchor[pool_id]  # reject if >+25% of anchor
```

**Wide math required:** naive form `new_price * 150` overflows uint64 for LP prices above ~1.2 × 10^17 (physically impossible, but best practice is to match WideRatio/mulw+divw pattern used throughout the protocol).

**Two-tier bounding (P19-03):** the prior-guard bounds movement per update; the anchor band bounds *cumulative* drift. Without the anchor, a compromised bot could post +49% repeatedly and walk the price arbitrarily far over many updates — enabling over-borrow and real bad debt. With the anchor, total drift is capped at ±25% until the admin re-anchors under the hardware wallet (a step the bot cannot perform).

**First-post security:** `add_pool()` now takes an `initial_price` set by the admin under the hardware wallet. This price is stored immediately, making the deviation guard active from the very first bot update. The unguarded first-post window (AUD-003) is eliminated.

The 50% guard catches catastrophic oracle compromise or severely broken price sources. The bot's tighter divergence checks (15–20%) catch routine data quality issues before they reach the contract.

---

## Oracle Bot Architecture

The bot runs on the same interval as the v1 oracle (5 minutes). It prices each supported LP pool in sequence.

### Price Sources

| Priority | Source | Method |
|---|---|---|
| 1 | Vestige API | `GET /v1/assets/{pool_id}/lp-price` — direct LP pricing if available |
| 2 | Computed from Vestige asset prices + on-chain pool state | Fetch $U/USDC and ALGO/USDC from Vestige; read pool reserves from algod |
| 3 | Full on-chain fallback | Read all data from algod only (pool reserves + Tinyman global state for total LP supply) |

### Computation Steps (for each pool)

```python
# Step 1: fetch underlying asset prices in USDC
u_price_usdc   = fetch_price(U_ASA_ID)    # from Vestige or Haystack
algo_price_usdc = fetch_price(ALGO_ASA_ID)

# Step 2: read pool state from algod
pool_state  = algod.get_application_state(pool_app_id)
reserve_a   = pool_state["asset_1_reserves"]  # base units
reserve_b   = pool_state["asset_2_reserves"]  # base units
total_lp    = pool_state["lp_asset_total"]    # LP token base units

# Step 3: compute TVL with decimal normalization
tvl_a = (reserve_a / 10**decimals_a) * price_a
tvl_b = (reserve_b / 10**decimals_b) * price_b
pool_tvl = tvl_a + tvl_b

# Step 4: compute price per LP token scaled to 6 decimal places
lp_supply_display = total_lp / 10**LP_DECIMALS  # LP tokens have 6 decimals
lp_price_display  = pool_tvl / lp_supply_display
scaled_price      = int(lp_price_display * 1_000_000)

# Step 5: divergence check against other sources (same as v1)
if max(prices) / min(prices) > 1.15:
    skip_update()
    alert("Source divergence")
    return

final_price = median(prices)
post_to_oracle(pool_id, final_price)
```

---

## Manipulation Resistance

### Why LP Manipulation Is Harder Than Spot Manipulation

Algorand does not support flash loans (no atomic borrow-use-repay within a single transaction group from external capital). Pool manipulation requires the attacker to hold real capital in the pool. Large swaps to move pool reserves leave the attacker exposed to arbitrage.

**Residual risk:** a whale with significant capital could temporarily move pool reserves within a block to inflate or deflate LP prices before oracle reads. TWAP mitigates this.

### TWAP (Time-Weighted Average Price)

The bot maintains a rolling price history per pool. Before posting a new price, the bot computes a time-weighted average over the last N readings:

```python
# Rolling history: list of (timestamp, price) tuples, max N entries
history[pool_id].append((now, computed_price))
if len(history[pool_id]) > TWAP_WINDOW:
    history[pool_id].pop(0)

# Trapezoidal time-weighted average (includes both endpoints of each interval)
total_time  = history[-1][0] − history[0][0]
weighted    = sum((history[i+1][0] − history[i][0]) × (history[i][1] + history[i+1][1]) / 2
                  for i in range(len(history)−1))
twap_price  = int(weighted / total_time) if total_time > 0 else computed_price
```

**TWAP window (TBD):** recommended 3–5 readings (15–25 minutes). Longer window is more manipulation-resistant but slower to reflect genuine price moves.

The bot posts the TWAP price, not the spot price. A one-reading spike (from temporary pool manipulation) is smoothed over subsequent readings.

### Circuit Breakers

Before posting any price:
1. **Asymmetric divergence check:** if spot price is >15% **above** TWAP, skip update (potential upward manipulation). Price drops are not blocked — silencing the bot during a genuine price decline causes oracle staleness exactly when health-factor liquidations are most needed. A downward spread only logs a warning and posts the TWAP, which reflects the move gradually.
2. **On-chain deviation guard:** if new price is >50% from prior, contract rejects (same as v1)
3. **TWAP smoothing:** spot manipulation has limited effect if TWAP window is > 1 reading
4. **Zero price guard:** if computed LP price is zero (zero-reserve pool), skip and alert

---

## Freshness Window

Vaults reject new borrows and health factor evaluations if any required LP pool's price is stale:

```
assert current_timestamp − lp_last_updated[pool_id] ≤ FRESHNESS_WINDOW
```

**Freshness window (TBD):** recommended 30 minutes (longer than v1's 10 minutes because LP prices are less volatile intrablock than spot prices). A stale oracle freezes vault borrowing safely — existing positions continue accruing interest, and collateral deposits / interest payments remain unblocked.

---

## Oracle Uptime

As with v1, oracle uptime is an operational safety requirement. Stale LP prices block new borrows and prevent admin-triggered health-factor liquidations (since health factor cannot be reliably computed). A complete bot outage for the freshness window effectively pauses the protocol's growth.

Bot uptime monitoring, alerting, and redundancy (multiple bot instances, multiple price sources) are operational requirements before mainnet launch.

---

## Per-Pool Price Key Design

The oracle stores one `lp_price_[pool_id]` per supported pool. The `pool_id` is the Tinyman pool app ID, which is globally unique on Algorand. Vault contracts reference their pool's oracle price by submitting the pool ID when calling `get_lp_price()`.

This design allows:
- Adding new vault types (LP pools) with no oracle contract redeployment — just add to whitelist
- Removing deprecated pools — remove from whitelist; existing positions close naturally
- Independent update frequencies per pool — high-volatility pools can be updated more frequently

---

## Wallet Separation

Three-key model:

| Wallet | Privileges |
|---|---|
| Oracle bot wallet | `update_lp_price()` only — hot wallet, minimum ALGO |
| Admin wallet (hot) | `add_pool()`, `remove_pool()`, `set_authorized_updater()`, `set_price_anchor()` — hardware wallet |
| Guardian wallet (cold) | admin recovery (`propose_admin`), guardian rotation — cold multisig |

**Bot-compromise blast radius (corrected — P19-03):** a compromised bot key can post bad prices only within ±50% of the prior post **and** ±25% of the admin anchor. Worst case is therefore *bounded* mispricing plus staleness — not arbitrary drift, and not unbounded fund loss. The earlier claim that bot compromise carries "no fund risk" was too strong: within the ±25% band a bad price can still enable some over-borrow, which is why the band is tight and the admin holds the re-anchor key. To move price beyond the band an attacker needs the admin key (to re-anchor), not just the bot key.

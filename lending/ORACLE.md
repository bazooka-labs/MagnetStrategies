# Magnet Lending — Oracle

## Why an Oracle Is Needed

The lending protocol requires a reliable $U/USDC price to:
- Value collateral when a borrow is requested
- Calculate health factors on existing positions
- Determine when a position is eligible for liquidation

USDC is treated as a constant ($1.00). The only live price needed is **$U expressed in USDC**. All protocol math derives from this single number.

**Known assumption:** USDC is assumed to equal $1.00. In a de-peg event, the $U/USDC exchange rate from on-chain pools already reflects real exchange value through arbitrage. A severe USDC collapse is treated as a protocol emergency requiring manual intervention. This assumption is consistent with the majority of DeFi protocols and acceptable at current TVL.

---

## Wallet Separation

The oracle bot wallet and the admin wallet are **separate keys with separate permissions**:

| Wallet | Privileges | Storage |
|---|---|---|
| Oracle bot wallet | `update_price()` only | Hot wallet, minimum ALGO balance |
| Admin wallet | Liquidation, fee collection, rate changes, oracle address update | Hardware wallet (Ledger) |

If the oracle bot wallet is compromised, the attacker can only attempt to post bad prices — blocked by the on-chain 50% deviation guard. The blast radius of bot key compromise is limited to oracle staleness, not fund loss.

---

## Oracle Contract

**Global state:**

| Key | Type | Description |
|---|---|---|
| `u_price` | uint64 | $U price in USDC, scaled to 6 decimal places (1.50 USDC = `1_500_000`) |
| `last_updated` | uint64 | Unix timestamp of last successful update |
| `authorized_updater` | bytes | Oracle bot wallet address |

**Methods:**
- `update_price(new_price: uint64)` — oracle bot wallet only; subject to on-chain deviation guard
- `get_price()` — read-only; lending pool contracts read via cross-app state reference

**Staleness guard:** lending contracts reject new borrows and health factor evaluations if `last_updated` is more than 10 minutes old. Protocol freezes safely rather than operating on stale prices.

**Safety dependency:** oracle bot uptime is directly tied to liquidation safety. A stale oracle blocks new liquidations from being triggered, allowing bad debt to accumulate during the outage window. Bot uptime is an operational priority, not a convenience. Monitoring and alerting on bot health is required.

---

## Oracle Address Storage

The oracle contract's app ID is stored in **each pool contract's global state** and is updatable by the admin wallet via `set_oracle(new_app_id)`. It is not hardcoded at deployment.

This provides operational flexibility — if the oracle contract ever needs to be redeployed, the pool contracts can be pointed to the new oracle without redeployment.

**Trust note:** the ability to update the oracle address means a compromised admin wallet could redirect pools to a malicious oracle. This is a known trust assumption — the admin wallet is on a hardware wallet and holds no higher privilege than already assumed by the protocol's trust model.

**Deployment checklist:** both pool contracts must reference the same oracle app ID at launch. Verify before opening the protocol to users.

---

## On-Chain Price Deviation Guard

`update_price()` enforces a maximum price movement per update at the contract level — independent of the bot's off-chain divergence checks:

```python
# Inside update_price() — enforced by the contract
if current_price != 0:                               # skip on first-ever post
    Assert(new_price >= current_price × 50 / 100)   # reject if >50% drop
    Assert(new_price <= current_price × 150 / 100)  # reject if >50% spike
# When current_price == 0 (initial state), any valid price is accepted
```

The guard is skipped on the very first price posting (`current_price == 0`) because there is no prior value to compare against. After the first post, all subsequent updates are subject to the 50% deviation limit.

This guard is wider than the bot's 15% source-divergence check — it catches catastrophic key compromise or severely buggy price sources, not routine volatility. A genuine 50%+ $U move within a 5-minute window triggers the guard, causes oracle staleness, and freezes the protocol safely.

**The bot's divergence check (off-chain) and the contract guard (on-chain) are two independent layers. Both must pass for a price update to land.**

---

## Price Representation

Stored as `uint64` scaled to 6 decimal places:

```
1.50 USDC  →  1_500_000
0.75 USDC  →    750_000
2.00 USDC  →  2_000_000
```

All collateral valuations and health factor math use this scaled integer. Frontend display values divide by `1_000_000`.

---

## Price Sources

| Priority | Source | Type | Notes |
|---|---|---|---|
| 1 | Vestige API | Off-chain aggregator | Covers all Algorand venues, ecosystem standard |
| 2 | Haystack | Off-chain aggregator | Independent cross-DEX, handles multi-hop natively |
| 3 | TinyMan on-chain | On-chain fallback | Two algod reads, cannot go offline |

### TinyMan Fallback (Two-Hop Calculation)

No direct $U/USDC pool exists on TinyMan. The bot reads two pools and applies decimal normalization before multiplying — raw reserve division gives values in incompatible base units that must be corrected first:

```python
# All reserve values from algod are in base units
u_pool_algo   = read_reserve(U_ALGO_POOL_ID, "asset_1_reserves")  # microALGO
u_pool_u      = read_reserve(U_ALGO_POOL_ID, "asset_2_reserves")  # $U base units (5 dec)
usdc_pool_algo = read_reserve(ALGO_USDC_POOL_ID, "asset_1_reserves")  # microALGO
usdc_pool_usdc = read_reserve(ALGO_USDC_POOL_ID, "asset_2_reserves")  # microUSDC (6 dec)

# Step 1: $U price in ALGO (display units: ALGO per $U)
# Correct for decimal difference: $U has 5 decimals, ALGO has 6
# u_price_algo = (u_pool_algo / ALGO_DECIMALS) / (u_pool_u / U_DECIMALS)
#              = u_pool_algo × U_DECIMALS / (u_pool_u × ALGO_DECIMALS)
#              = u_pool_algo × 100_000 / (u_pool_u × 1_000_000)
#              = u_pool_algo / (u_pool_u × 10)
u_price_algo = u_pool_algo / (u_pool_u * 10)
if u_price_algo == 0:
    raise ValueError("TinyMan $U/ALGO price resolved to zero — skipping fallback")

# Step 2: ALGO price in USDC (display units: USDC per ALGO)
# Both have 6 decimals — no correction needed
algo_price_usdc = usdc_pool_usdc / usdc_pool_algo

# Step 3: $U price in USDC, scaled to 6 decimal places for oracle storage
u_price_usdc  = u_price_algo * algo_price_usdc
scaled_price  = int(u_price_usdc * 1_000_000)
```

Raw multiplication without decimal correction (`u_algo * algo_usdc`) would produce a result off by a factor of 10 — wrong by an order of magnitude.

**Known limitation:** introduces ALGO/USDC pool depth as a dependency. ALGO/USDC has sufficient liquidity to make manipulation impractical at current scale.

---

## Bot Architecture

```python
sources = []

# 1. Vestige — primary
try:
    sources.append(("vestige", fetch_vestige_price(U_ASA_ID)))
except:
    alert("Vestige unavailable")

# 2. Haystack — independent aggregator
# amount=100_000 = 1 full $U in base units (5 decimals); verify against Haystack API docs
try:
    sources.append(("haystack", fetch_haystack_quote(U_ASA_ID, amount=100_000)))
except:
    alert("Haystack unavailable")

# 3. TinyMan on-chain — always attempt
try:
    u_algo    = read_tinyman_reserves(U_ALGO_POOL_ID)
    algo_usdc = read_tinyman_reserves(ALGO_USDC_POOL_ID)
    sources.append(("tinyman", u_algo * algo_usdc))
except:
    alert("TinyMan read failed — critical")

if not sources:
    skip_update()
    alert("All sources failed — staleness guard active")
    return

prices = [p for _, p in sources]
if max(prices) / min(prices) > 1.15:
    skip_update()
    alert(f"Source divergence: {sources}")
    return

final_price = median(prices)
post_to_oracle(final_price)
# On-chain 50% guard is the second independent layer
```

**Update interval:** every 5 minutes | **Cost:** ~8.6 ALGO/month

---

## Atomic Group Manipulation

Not applicable. The lending contracts read from the oracle's stored `u_price` — not from live DEX pool state. Pool manipulation within an attacker's atomic group has no effect on the posted price.

---

## Upgrade Path

The oracle contract's `authorized_updater` can be reassigned to a decentralized feed with no changes to the lending pool contracts. Pool contracts reference the oracle by app ID stored in global state.

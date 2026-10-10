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

Pool app id = the Tinyman v2 LP token ASA (used as `pool_id` on-chain). Live pools are registered on
the oracle via `add_pool` and priced by the bot (`oracle_bot/config.json`).

| Pool | Pool App ID (LP ASA) | Assets | Status |
|---|---|---|---|
| U/tALGO | `3163770927` | $U + tALGO | ✅ live |
| U/USDC | `3673941603` | $U + USDC | ✅ live (2026-08-19) |
| U/ALGO | TBD | $U + ALGO | planned |
| U/wBTC | TBD | $U + wBTC (bridged; verify ASA decimal count before deploy — see AUD-006) | planned |

---

## Methods

### Admin Sender Assertion

All admin methods must include as their **first assertion**: `Assert Txn.sender == admin`

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
1. Assert `Txn.sender == admin`
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
1. Assert `Txn.sender == admin`
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

### Price Sources (on-chain — no external HTTP price API)

The bot derives every price directly from on-chain Tinyman v2 pool reserves, then
cross-checks the volatile underlying against CompX's on-chain Flux oracle. There is
**no dependency on an external price API** — the original Vestige integration was
removed after its endpoint was retired, and a single external feed was the P19-02
single-point-of-failure anyway.

| Role | Source | Method |
|---|---|---|
| **Primary** | On-chain reference-pool graph (Tinyman v2) | Price each underlying in USDC by walking pool ratios rooted at USDC: `ALGO ← ALGO/USDC`, `tALGO ← tALGO/ALGO`, `U ← U/tALGO`. Reserves read from each pool account's local state under the AMM validator app. |
| **Second source / divergence guard (P19-02)** | CompX Flux oracle (on-chain, mainnet app `3307588794`) | Read the volatile underlying's price from CompX's price box (`"prices"+uint64(assetId)`, tuple `(assetId, price, lastUpdated)` ×1e6). If the bot's derived price diverges beyond `compx_divergence_limit` (default 5%) while CompX is fresh, the post is refused (fail-stale). If CompX **cannot** verify (unavailable / stale / assetId mismatch) the strong guard is off, so the bot posts only flat or small declines (≤10%) and **refuses any increase or large drop** — this prevents an attacker from disabling the guard (DoS/stale CompX) and then pushing a manipulated up-move or MEV down-move through (Pass 26 F1/F5/F6). |

`reference_pools` in `config.json` maps each asset → `{pool_address, quote_asset_id}`; `compx_oracle_app_id` + per-pool `compx_check_asset_id` configure the cross-check. Live cross-check at build time: derived $U `$0.1176` vs CompX `$0.1186` (Δ0.86%).

### Computation Steps (per pool)

```python
# 1. Read the LP pool reserves + issued LP from the pool ACCOUNT's local state
pool_state = account_application_info(pool_address, amm_validator_app_id).local_state
reserve_a, reserve_b = pool_state["asset_1_reserves"], pool_state["asset_2_reserves"]
total_lp             = pool_state["issued_pool_tokens"]

# 2. Derive each underlying's USD price ON-CHAIN via the reference-pool graph
#    (recursive, memoized, rooted at USDC = 1.0; e.g. U ← U/tALGO × tALGO ← tALGO/ALGO × ALGO ← ALGO/USDC)
price_a = derive_asset_price_usdc(asset_a)
price_b = derive_asset_price_usdc(asset_b)

# 3. TVL with decimal normalization → price per LP token (scaled 1e6)
pool_tvl     = (reserve_a/10**dec_a)*price_a + (reserve_b/10**dec_b)*price_b
scaled_price = int((pool_tvl / (total_lp/10**LP_DECIMALS)) * 1_000_000)

# 4. Absolute sanity bound, then CompX second-source cross-check (fail-stale on divergence)
if not (min_price <= scaled_price <= max_price): return            # skip
cx = read_compx_price(compx_oracle_app_id, compx_check_asset_id)    # CompX Flux oracle box
if cx and cx.fresh and abs(derived_check - cx.price)/cx.price > divergence_limit:
    return                                                          # skip (fail-stale)

# 5. Trapezoidal TWAP (≥3 readings) + asymmetric divergence guard, then post
post_to_oracle(pool_id, twap(scaled_price))
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

### Host requirement: a current TLS trust store

The bot host must be able to validate **Let's Encrypt** certificates. This is not
incidental housekeeping — it decides whether alerting works at all.

The bot makes outbound HTTPS calls to three places, and they do not share a CA:

| call | host | CA |
|---|---|---|
| post price | `mainnet-api.algonode.cloud` | Google Trust Services |
| PEX cross-check | `…r2.dev` oracle payloads | **Let's Encrypt** |
| alert delivery | `ntfy.sh` (or chosen webhook) | **Let's Encrypt** |

On 2026-10-09 the Windows host rejected the PEX bundle with `certificate verify
failed: certificate has expired` while posting prices normally. The PEX leaf was
valid (Sep 7 – Dec 6 2026), so the expired anchor was in the host's own store.

The failure therefore split by CA, not by host: **every** Let's Encrypt endpoint
was unreachable, including the alert channel. A trust store too old to read the
PEX feed is also too old to deliver the page about the outage, and `notify()`
logs that failure to the unattended machine nobody is reading — so the only
visible symptom was a cross-check warning that looks like a minor telemetry gap.

Two mitigations, both in place:

- `_tls_context()` builds the context from **certifi's** bundle, which takes the
  OS store out of the path. `certifi` is a declared dependency; the function
  falls back to the OS store if it is absent, so this is a preference, not a
  hard requirement. All three call sites share the one context — an AST test
  asserts no `urlopen` call can be added without it.
- Keep `certifi` updated on the host (`pip install -U certifi`) alongside the
  bot's other dependencies.

**Related:** bot logs are stamped UTC via `logging.Formatter.converter =
time.gmtime`. The `datefmt` ends in `Z`, and Python's default converter is
`localtime` — the same 2026-10-09 log stamped `20:46:46Z` on an event at
`00:46Z`. The age figures in those lines were correct (`lp_ts_` is an epoch),
which is what made the mislabelled stamp worse than an obviously wrong one: it
reads as directly comparable to on-chain timestamps during an incident.

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

---

# v4 — Signed Payloads (decided 2026-10-07, not yet built)

**Status: agreed direction, pre-build.** Everything above describes the live
posted-price oracle and remains accurate until v4 ships.

## The decision

Stop posting prices on chain. The signer publishes a signed, TWAP-smoothed
payload off chain; the **user carries it in their own transaction**; the vault
verifies the signature and uses it. Same pattern PEX uses, which this
organisation already integrates against and has read the verification path for.

## Why — the evidence, not the theory

Three oracle freezes to date. Zero key compromises.

The protocol had been heavily defended against a stolen bot key and barely at
all against the oracle simply stopping — and the second is the failure that has
actually happened, repeatedly. On 2026-10-07 one feed sat dead for over nine
hours; the vault fails closed, so borrowing and **all three liquidation paths**
were reverting on that pool for the whole window.

The two risks are not comparable in size:

| | bound |
|---|---|
| **key compromise** | capped at the PSM USDC reserve — `circulating mUSD ≤ psm_usdc` caps minting and redemption is the only exit. $151 at the time of writing; $5–10k projected for the next few years |
| **oracle freeze during a drawdown** | the entire loan book, because liquidations cannot run |

Worse, the freeze is guaranteed to coincide with the need: the band locked at
−25% while live borrowers only become liquidatable at −53%.

## What is removed, and why each one goes

| removed | reason |
|---|---|
| on-chain posted price | nothing standing means nothing to go stale |
| `lp_ts_` freshness window | same |
| anchor, anchor band (±25%) | anti-key-compromise only — risk accepted at this scale |
| ±50%-vs-prior guard | same |
| `set_price_anchor` + the re-anchor chore | no anchor to move |
| per-pool `min_price` / `max_price` | absolute constants that rot; caused every outage so far |
| `asset_price_bounds` | same failure with a longer fuse — ALGO's $0.50 ceiling against a $0.119 price |
| posting fees (~$2/mo) | no posts. Never the point, but it goes |

## What stays, and why it is not optional

**Off chain, in the signer — these catch BUGS, which key custody does not:**

- **TWAP smoothing.** Signing a *spot* price on a pool as thin as U/tALGO means
  anyone who can move it for one block can make us sign anything. This is the
  one genuinely catastrophic thing that could be dropped here, and it must not
  be.
- **A second opinion on the derived asset price.** Today that is CompX's Flux
  oracle. CompX may be closing its single-token lending markets, which puts the
  Flux oracle at risk, so the replacement is specified in
  "[Second-source options](#second-source-options-if-compx-goes-away)" below.
  What is not optional is *having* one — not CompX specifically.

A bug cannot bypass these, because a bug still runs our code. Only a stolen key
does, and that is the accepted risk.

**On chain — these are not defences, they are what makes a signature mean
anything:**

| | why |
|---|---|
| verify the signature | how the contract knows the price is ours |
| payload expiry (~20s) | **replay protection** — see below |
| `price > 0` | a zero permanently bricks the pool (AUD-042) |
| pool whitelist | so a payload for one pool cannot price another |

**The expiry is not about our key at all.** A signed payload is public the moment
it is used. Anyone — no key required — can keep a copy of one signed during a
price spike and replay it later. That is arithmetic on public data, not a
compromise, and it is why PEX validates for 20 seconds.

## The trade, stated plainly

A **staleness** problem becomes an **availability** problem.

- Posted: long fuse, slow recovery. 2026-10-07 took nine hours to notice, then a
  config edit, a restart, and a 15-minute TWAP warm-up.
- Signed: short fuse, instant recovery. Signer down means immediate failure;
  signer back means working on the next block.

For a protocol where liquidation is the thing that must work, the short fuse
with instant recovery is the better failure mode. It does convert the signer
from "a bot that should run" into "a service with real uptime requirements" —
which is the actual argument for the VPS, not the $2 of fees.

## Deployment shape

Copy PEX's, not just its verification model: the signer **pushes to object
storage** (they use a Cloudflare R2 bucket) and users fetch from the CDN. The
signing box accepts no inbound connections at all. Single-purpose host,
outbound only, signer key separate from the cold admin key and holding only fee
ALGO.

## Designs considered and rejected

- **Auto-recentering anchor (12h).** Still freezes if the price moves >25%
  inside a period — the same failure with more machinery.
- **Upward rate limit** (price may rise at most ~10%/hour, downward free).
  Strictly better than the band: tighter against an atomic attack (0.83% in
  normal operation vs 25%) and looser against the market. Rejected only because
  it defends solely against key compromise, which is accepted — but **this is
  the design to reach for first** if that acceptance is ever withdrawn.
- **Wide absolute sanity bound** (0.25×–4×). Same reasoning. It would raise an
  attacker's capital requirement rather than cap the loss, which the PSM reserve
  already does.

## Migration note

This is a **vault** contract change, and the vault is the one piece with no
repointing path (the oracle is swappable via `propose_lp_oracle`; the vault is
not). It should therefore ship in the **same migration** as the public-lending
contract shape — see [TODO.md](./TODO.md). Two expensive migrations become one,
and the window is open while the book is 3 vaults and $950.


---

# Second-source options if CompX goes away

_Measured 2026-10-10, prompted by word that CompX may close its single-token
lending markets. The Flux oracle (app `3307588794`) is CompX infrastructure, so
treat it as at-risk._

## The question splits in two, and the halves have very different answers

### The ALGO leg — solved, and better than what it replaces

ALGO is the root of the whole reference graph (`U ← U/tALGO × tALGO ← tALGO/ALGO
× ALGO ← ALGO/USDC`) and the volatile side of the new ALGO/USDC collateral.

**Use PEX's signed payloads.** Already built and working in
`read_pex_algo_price()`: 133-byte `PDX2` message, ed25519 against a pinned
pubkey, every field read from the signed bytes rather than the JSON envelope.
Measured 2026-10-10: PEX `$0.116598` vs our derivation `$0.116120` — **0.41%**.

This is a strict upgrade, because **CompX does not price ALGO at all.** Its box
set is `{$U, mUSD, goBTC, ETH, two BTC-ish, USDC (211 days stale), one
memecoin}` — there is no asset-id-0 box.

> ### Latent defect found while checking this
> `compx_check_asset_id: 0` **silently disables** the cross-check, because
> `compx_cross_check` opens with `if not pool.compx_check_asset_id: return "ok"`
> and asset id 0 is falsy. Asset 0 is *also* ALGO, so the ALGO/USDC config block
> reads as "cross-check ALGO" and means "do not cross-check" — and the log then
> prints `compx_verified=True`, which reads as verified but means unchecked.
> Nothing was lost (CompX has no ALGO price), but the sentinel needs to be `None`
> or `-1` before anyone relies on that field for ALGO.

### The $U leg — no clean replacement exists, and that is a liquidity fact

| source | kind | independent of Tinyman? | verdict |
|---|---|---|---|
| CompX Flux oracle | on-chain box read | **probably not** — see below | at risk |
| **Tinyman multi-route** | on-chain reserves | no (same venue) | **primary replacement** |
| Pact API asset price | off-chain HTTP | yes | useful third opinion |
| Pact on-chain pools | on-chain reserves | yes | weak primitive — see below |
| Vestige | off-chain HTTP | yes | cannot see Pact's MW pools (`pools.ts:193`) |
| PEX | signed payload | yes | **cannot price $U** |

**Tinyman multi-route is the recommended primary — as a CROSS-CHECK, not a
median.** $U can be priced three ways through pools we already read, and they
agree (2026-10-10):

| route | $U |
|---|---|
| U/USDC direct | $0.160037 |
| U/tALGO → tALGO → ALGO | $0.161135 |
| U/ALGO → ALGO | $0.161640 |
| **median** | **$0.161135** |

Max spread vs median **0.681%**; median vs CompX **0.269%**.

> **Caveat on what this table measures.** "Cost to move the implied $U price"
> load-bears on the **U/USDC** posted price. It does **not** describe U/tALGO,
> whose posted LP price is algebraically *independent* of the $U price: route 0
> for $U is that same pool, so substituting `P_U = (tALGO_res/1e6)/(U_res/1e5) ×
> P_tALGO` into the TVL cancels the $U reserve exactly, leaving
> `lp_price = 2 × (tALGO_res/1e6) × P_tALGO / (LP_supply/1e6)`. Verified to 1
> part in 1e6 against a live post. The cheap lever on *that* price is the
> **tALGO** reserve, which no route choice addresses — see REVAMP_PLAN Phase
> 0.7.

> ### Correction, same day: a median would have been WORSE
>
> The first version of this section said "take the median of three". That was
> written before the routes' depth was measured, and the measurement overturns
> it:
>
> | $U route | pool TVL | cost to move its implied $U price 10% |
> |---|---|---|
> | U/tALGO | $21,213 | **~$518** |
> | U/USDC | $2,943 | ~$72 |
> | U/ALGO | $2,555 | ~$62 |
>
> A median of three only moves when **two** routes move — and the two cheap ones
> together cost **~$134**, against **~$518** for the deep one alone. So a median
> would have made manipulation roughly **4× cheaper** than what the bot already
> does, which is to price through the deepest pool. Redundancy loses to depth
> when the pools are this unequal.

**So: route 0 prices, the rest cross-check.** `reference_pools[asset]` is an
ordered list whose first entry is the deepest pool; later entries are computed,
compared, and logged. They never change the price and never stop the feed — a
thin pool going empty must not halt pricing. Divergence over **2%** logs at
ERROR (0.68% observed, so 1% would be noisy).

This keeps manipulation cost exactly where it is today while adding the bug
detection CompX was providing, and it costs nothing — the pools are already
being fetched. It also gets stronger with each pool added, since a new $U pool
is another cross-check.

**It is a trade, not a clean win.** A median is genuinely more *tolerant* of a
broken route — median{good, good, garbage} is still good, whereas route-0
pricing is fully determined by one pool and can only *detect* a bad route via an
advisory log. Since the motivating threat was losing CompX, i.e. losing bug
detection, the median was the stronger design on that axis. It loses on two
others that were judged to matter more: manipulation cost (3.86x, simulated
end-to-end on live reserves), and the constraint that a cross-check must never
silently change the posted price. Recorded so the next reader does not have to
re-derive it.

**Why losing CompX costs less than it appears.** Pact's $U pools are all
`MANAGED_WEIGHTED` and, per `pools.ts:193`, invisible to the usual aggregators;
Tinyman is where $U depth and all stable/ALGO-paired $U liquidity sits. So
CompX's $U price is almost certainly derived from the same Tinyman pools we read.
Its independence was in the **implementation**, not the venue — and three
independent routes through our own arithmetic recover most of that. *(Inference:
CompX's internals are not public.)*

What multi-route does **not** catch is a systematic error in the shared
primitives — `_pool_reserves`, decimals handling, the `sqrt` LP formula. Only an
externally-computed number catches those, which is the one real argument for
keeping an outside source in the loop.

**Pact is real liquidity but a poor pricing route.** ~$22k of $U across four
pools, comparable to Tinyman's ~$26k:

| Pact pool | TVL |
|---|---|
| U/FOLKS | $9,738 |
| U/ALPHA | $6,244 |
| U/COMPX | $5,022 |
| U/HAY | $987 |

Two problems. First, **every pair is $U against a small token** — never ALGO or
a stable — so each route needs ALPHA/COMPX/HAY/FOLKS priced first, through
assets thinner than $U itself. Second, they are `MANAGED_WEIGHTED`: price is
`(reserve_b/weight_b) / (reserve_a/weight_a)`, and **the manager can reweight**,
moving the implied spot price with no trade at all. That is a materially weaker
oracle primitive than Tinyman's constant product.

Pact's **API** is the usable part: it publishes an aggregate $U price
(`primary_asset.price`), reading **$0.15915** on 2026-10-10 — 1.2% below our
median. Genuinely venue-independent, and the natural CompX replacement for the
external tier. The cost is an HTTP dependency, which P19-02 deliberately
removed; acceptable for an **alert-only** check, and not acceptable as anything
a post depends on.

## Recommendation

Three tiers, none load-bearing on a single vendor:

1. **TWAP** on our own derivation — unchanged, and still the one thing that must
   not be dropped.
2. **Multi-route cross-check** for every asset with more than one path ($U has
   three). The DEEPEST route prices; the others are compared and logged at 2%
   divergence. Not a median — see the correction above. On-chain, free, no
   vendor, and advisory so it can never halt the feed.
3. **One external number, alert-only** — PEX for ALGO (already built, pinned
   key), and CompX for $U while it lives, falling back to Pact's API. Never
   gates a post.

Tier 2 is the work: it replaces a vendor dependency with arithmetic over pools
already being read, and it is the only option here that gets *stronger* as
collateral is added, since each new $U pool is another route.

**Shipped 2026-10-10** for $U (three routes, U/tALGO pricing). `asset_price_bounds`
was NOT removed alongside it — see the note below.

### Why `asset_price_bounds` stays until v4

The plan had this replaced by the cross-check. It isn't, for a reason worth
recording: the cross-check only exists for assets with more than one route, and
**ALGO and tALGO have exactly one each**. Dropping their absolute bound would
remove a layer with nothing behind it.

The natural replacement for ALGO is PEX, which is already integrated and pinned.
`strategy/perps/SPEC.md` invariant 5 is the coupling rule here: *"no Perps code
path makes PEX state an input to a MagnetFi solvency decision."*

Stated precisely, because an earlier revision of this paragraph said SPEC.md
"forbids" it and that is stronger than the spec claims. Its own parenthetical
says so: *"Stated as a constraint on Perps, which is what Perps can enforce.
Whether MagnetFi ever accepts PEX-derived collateral is a MagnetFi policy
decision, not something this codebase can assert."* So the Perps side is
closed, and the MagnetFi side is **an open decision this document is not
entitled to make by default**. Taking it should be deliberate, not a side
effect of a cleanup.

The bounds are also not yet rotten: ALGO's `[0.02, 0.50]` against a $0.1155
price is 0.17×–4.3×, which is in the usual sanity-bound range. They go at v4
with the rest of the posted-price machinery.

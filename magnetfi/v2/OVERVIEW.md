# MagnetFi v2 — LP Vault + mUSD

## What Is This?

MagnetFi v2 protocol is a new approach into Algorand DeFi by leveraging yield bearing LP tokens as suitable collateral for Magnet's own Algorand-native stablecoin $mUSD. Users deposit Tinyman LP tokens as collateral and borrow mUSD where the peg is guaranteed by a protocol-owned reserve module. Repayment is mandatory but interest-only; principal is optional and unlocks collateral. 

This is an admin-managed protocol with a two-role security model: a hot **admin** key controls rates, reserve levels, and liquidation triggers, while a cold **guardian** key can pause the protocol, veto the timelocked oracle/vault repointing powers, and recover a lost or compromised admin key. There is no external governance at launch. See [Admin](./ADMIN.md) for the full trust model.

---

## Protocol Architecture

```
Admin Wallet (Bazooka Labs)
    ↓
PSM Contract              ← holds USDC reserves; issues and redeems mUSD
    ↕
Vault Contract            ← accepts LP collateral; mints mUSD up to PSM ceiling
    ↕
LP Oracle Contract        ← values LP positions by (LP balance / total LP supply) × pool TVL
    ↕
mUSD ASA                  ← Algorand-native stablecoin; total minted ≤ PSM USDC reserves
```

---

## Core Invariant

> **Circulating mUSD ≤ PSM USDC reserves at all times.**

"Circulating mUSD" is all mUSD not held by the PSM — regardless of whether it entered circulation via vault borrowing or direct PSM mint.

This invariant is enforced at the contract level, but the two mUSD entry paths stress it differently:

- **Vault borrow:** PSM issues mUSD without receiving USDC → circulating increases, PSM USDC unchanged → vault ceiling shrinks
- **PSM direct mint (USDC → mUSD):** USDC enters PSM at the same moment mUSD is issued → both sides increase equally → invariant is never stressed; vault ceiling unchanged

The practical constraint is vault minting. PSM direct mints are self-balancing and can never break the invariant. Admin cannot withdraw PSM USDC below circulating mUSD. The peg is mathematically guaranteed as long as the invariant holds.

---

## Peg Stability Module (PSM)

The PSM is a protocol-owned fixed-rate swap module. It is not an AMM.

| Direction | Rate | Fee |
|---|---|---|
| USDC → mUSD (Mint) | 1:1 | 0% — friction-free entry |
| mUSD → USDC (Redeem) | 1:1 | 1% → treasury wallet |

- The PSM is a first-class user-facing product — anyone can mint mUSD by depositing USDC (no vault needed)
- Redemption fee (1%) routes directly to treasury per transaction; it does not accumulate in PSM reserves
- Vault ceiling grows via admin USDC deposits and vault repayments; PSM swaps are self-balancing
- Admin-only: add or withdraw USDC from PSM (withdraw guard: cannot drop below outstanding mUSD)
- No external LPs; all reserves are protocol-owned

---

## Vault

Each vault is an LP collateral position. A borrower deposits a Tinyman LP token and mints mUSD up to the vault's LTV limit.

### Vault Types (planned)

| Vault | LP Pair | LTV | Liq. Threshold | Interest Rate (APR) |
|---|---|---|---|---|
| U/USDC LP | $U + USDC | 65% | 75% | ~5% |
| U/ALGO LP | $U + ALGO | 60% | 75% | ~8% |
| U/tALGO LP | $U + tALGO | 60% | 75% | ~8% |
| U/wBTC LP | $U + wBTC | 60% | 75% | ~8% |

### Repayment Model

- **Interest-only** — borrower owes accrued interest quarterly (every ~90 days)
- **Principal optional** — repaying principal in full returns all collateral; no mandatory repayment date
- **Grace period** — admin may trigger micro-liquidation at 90 days of non-payment; interest continues accruing until the admin acts; micro-liquidation seizes all accrued interest at execution time and resets the clock
- **Clock resets** on every interest payment or liquidation event

---

## Liquidation Paths

Two independent triggers, both admin-manual:

### Path 1 — Missed Payment (Micro-Liquidation)
- **Trigger:** 90+ days since last interest payment
- **Action:** Seize LP collateral covering accrued interest + 5% buffer (2% execution + 3% late fee)
- **Result:** Interest debt cleared, position continues, clock resets
- **Note:** Admin holds discretion on timing; known/trusted borrowers may receive extended grace

### Path 2 — Health Factor Breach (Tiered Liquidation)
- **Trigger:** LP collateral value causes health factor to fall below 1.0
- **Action:** 3-tier system based on severity — admin selects the correct tier for instant execution
  - HF 0.95–0.9999 → seize 35% LP; position continues with restored health
  - HF 0.85–0.9499 → seize 60% LP; position continues with restored health
  - HF < 0.85 → full seizure; position closed
- **Result:** Partial tiers restore the borrower's position while protecting the protocol; full seizure for deeply distressed positions
- **1-click design:** pre-calibrated percentages let the admin act immediately during fast-moving markets — no calculation required under pressure
- **LP advantage:** Redeeming LP splits collateral 50/50 across both pooled assets — halves price impact on any single asset (critical for $U price stability during liquidation events)

### Priority
If both triggers apply simultaneously, Path 2 (health factor) takes precedence.

---

## LP Oracle

LP positions are valued as:

```
position_value = (user_lp_balance / total_lp_supply) × pool_TVL
pool_TVL       = (asset_A_reserves × price_A) + (asset_B_reserves × price_B)
```

Data sources (planned): Vestige API, on-chain pool state (Tinyman), TWAP for manipulation resistance.
Circuit breakers: reject price updates with >50% deviation from prior reading (on-chain guard in LP Oracle contract).

→ [`LP_ORACLE.md`](./LP_ORACLE.md)

---

## Interest Rate Model

MagnetFi v2 offers **current fixed rates** — rates are set by the admin per vault type and lock in at the moment a borrower opens a position. The rate a borrower sees when opening a vault is their rate for the life of that position, regardless of any future admin adjustments.

- **New vaults** always open at the current advertised rate for that vault type
- **Existing positions** are never retroactively repriced — rate is locked in the vault box at open time
- **Admin** may adjust the current rate for new vaults in response to market demand or revenue goals; this never affects open positions

Fixed rates are a meaningful DeFi differentiator. Protocols like Aave and Compound offer variable rates that fluctuate with utilization. MagnetFi borrowers know their exact quarterly payment from day one and can plan accordingly.

The PSM removes the primary reason protocols use variable rates: peg maintenance. In utilization-based models, rates rise when the stablecoin trades below peg — that signal incentivizes repayment and supply reduction. In MagnetFi v2, the PSM's guaranteed redemption arbitrage restores the peg mechanically, without any interest rate signal required. Fixed rates are viable here specifically because the peg anchor exists at the contract level.

---

## Revenue Model

MagnetFi v2 has five revenue streams across two categories — automatic and admin-collected.

**Automatic (no admin action required):**

| Source | Asset | Trigger |
|---|---|---|
| PSM redemption fee | USDC (1% of swap) | Every mUSD → USDC redemption; routed to treasury per transaction |
| Protocol-owned DEX LP fees (future) | LP fees | Passively earned if treasury mUSD is deployed into a DEX pair |

**Admin-collected:**

| Source | Asset | Trigger |
|---|---|---|
| Vault loan interest | mUSD | Accumulates in vault contract; admin sweeps via `collect_fees()` when ready |
| Micro-liquidation late fee | LP tokens (~3% of accrued interest) | Included in 5% buffer on micro-liq seizure; excess above execution cost is revenue |
| Health liquidation surplus | LP tokens / underlying | Any LP value recovered above total debt after settlement |

**Primary growth lever:** loan interest scales directly with total vault TVL. PSM redemption fees scale with mUSD trading volume. As mUSD adoption grows across the Bazooka ecosystem, both streams compound together.

**Treasury strategy:** collected mUSD can either be converted to USDC and deposited into the PSM (grows vault ceiling) or deployed as protocol-owned DEX liquidity (builds mUSD market depth and earns passive LP fees). The right split depends on where the protocol is in its growth cycle — PSM compounding early, DEX liquidity as mUSD matures.

---

## Admin Controls

| Action | Who | Contract guard |
|---|---|---|
| Add USDC to PSM | Admin only | None — admin can always add |
| Withdraw USDC from PSM | Admin only | Cannot drop below total outstanding mUSD |
| Set vault interest rates | Admin only | Max 3000 bps (30% APR) |
| Trigger micro-liquidation | Admin only | Requires 90+ days since last payment |
| Trigger health liquidation | Admin only | Requires health factor below threshold |
| Collect loan interest | Admin only | None |

---

## What This Is Not

- Not a trustless protocol — admin holds real discretionary power
- Not a public AMM PSM — all PSM reserves are protocol-owned
- Not automated — no keeper bots or on-chain automation at launch
- Not cross-chain — Algorand only

---

## Status

| Component | Status |
|---|---|
| Architecture design | In progress |
| mUSD ASA | Not created |
| PSM contract | Not built |
| Vault contract | Not built |
| LP Oracle contract | Not built |
| Admin UI | Not built |
| Testnet deployment | Not started |

---

## Further Reading

- [mUSD](./mUSD.md) — stablecoin ASA design, mint authority, PSM reserve recycling, cross-contract invariant
- [Vault](./VAULT.md) — LP collateral, mUSD minting, interest-only repayment model, grace period
- [PSM](./PSM.md) — reserve mechanics, asymmetric fee model, self-balancing property, admin controls
- [LP Oracle](./LP_ORACLE.md) — LP valuation formula, data sources, TWAP, circuit breakers
- [Liquidation](./LIQUIDATION.md) — micro-liquidation, health-factor liquidation, state guards
- [Admin](./ADMIN.md) — all admin actions, monitoring checklist, deployment procedure, emergency runbook

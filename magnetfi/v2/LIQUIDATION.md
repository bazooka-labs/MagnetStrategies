# MagnetFi v2 — Liquidation

## Overview

MagnetFi v2 has two independent liquidation mechanisms serving different risks. Both are admin-triggered and manual — no automated bots, no public liquidators.

| Mechanism | Trigger | Risk Addressed |
|---|---|---|
| Micro-liquidation | 90+ days without interest payment | Borrower default / non-payment risk |
| Health-factor liquidation | LP collateral value below threshold | Collateral value decline risk |

These triggers are independent. A borrower can be current on payments but face health liquidation if their LP value collapses. A borrower can have a strong health factor but face micro-liquidation if they stop paying interest. Both guards must exist; both are required to protect protocol solvency.

---

## Vault Position States

```
State 0: active             → healthy, within payment window
State 1: payment_overdue    → 90+ days since last payment; admin may trigger micro-liq
State 2: in_liquidation     → health-factor collateral seizure in progress; settlement pending
```

**Transitions:**
```
active → payment_overdue:     90 days elapsed since last_payment_timestamp (detected via lazy check in vault interactions, or explicitly set by admin via mark_payment_overdue())
payment_overdue → active:     borrower pays accrued interest; clock resets
payment_overdue → active:     admin triggers micro-liquidation (seizure + clock reset in one tx; bypasses state 2)
active → in_liquidation:      health factor drops below threshold; admin triggers partial or full liq
payment_overdue → in_liquidation: health factor also breached; health liq takes priority
in_liquidation → active:      settlement complete, debt partially reduced, position continues (partial liq path)
in_liquidation → closed:      settlement complete, all debt cleared (full liq path)
```

**State 2 dual-use of vault box fields:**
While a vault is in state 2, `accrued_interest` is repurposed as the **settlement counter** — the mUSD amount the admin still owes back to the PSM. `musd_borrowed` holds the new reduced debt (already discounted by the seized LP value). Normal interest accrual is suspended in state 2. On settlement completion, `accrued_interest` is zeroed and `last_accrual_timestamp` is reset to the settlement block before returning to state 0.

---

## Micro-Liquidation (Missed Payment)

### Purpose

Ensures the protocol is compensated for interest owed even when the borrower goes silent. The micro-liquidation seizes a proportional slice of LP collateral to cover the outstanding interest obligation. The position does not close — the borrower keeps their principal open.

### Trigger Condition

```
vault_state == 1 (payment_overdue)
AND current_timestamp >= last_payment_timestamp + 90 days
AND accrued_interest > 0
```

The admin may act immediately at 90 days or wait longer. Interest continues accruing for every block the position sits unpaid — the seizure at execution covers all accrued interest at that moment, not just 90 days' worth. The 90-day mark is when the option becomes available, not when it must be exercised.

### Seizure Calculation

The amount of LP tokens seized covers the accrued interest plus an execution buffer:

```
interest_in_musd    = accrued_interest
buffer_bps          = 500   [5% — 2% execution + 3% late fee]
execution_buffer    = floor(interest_in_musd × buffer_bps / 10_000)
total_recovery_musd = interest_in_musd + execution_buffer

lp_price            = oracle.get_lp_price(vault.lp_pool_id)
lp_to_seize         = ceil(total_recovery_musd × 1_000_000 / lp_price)
                      [ceil rounds against borrower — protocol seizes marginally more]

assert lp_to_seize ≤ vault.lp_amount  [position must have enough collateral]
```

**Buffer breakdown — 5% total:**
- **2% execution buffer** — covers TWAP lag (oracle price may trail real-time by 15–25 min), Tinyman redemption fees (~0.3% per asset leg), and minor price movement between admin decision and transaction confirmation
- **3% late fee** — penalty for missing the 90-day payment window; signals that non-payment has a real cost without being punitive (this is charged on interest only, not principal)

Any amount recovered beyond the interest obligation at execution time becomes protocol revenue.

### Micro-Liquidation Flow

`trigger_micro_liquidation(borrower_address, pool_id)` — admin wallet only

1. Assert `vault_state == 1`
2. Assert `current_timestamp >= last_payment_timestamp + 90 days`
3. Assert oracle is fresh
4. Accrue interest to current timestamp
5. Compute `lp_to_seize` as above
6. Assert `lp_to_seize ≤ vault.lp_amount`
7. **All state changes before inner transactions:**
   - `vault.lp_amount -= lp_to_seize`
   - `vault.accrued_interest = 0`
   - `vault.last_accrual_timestamp = current_timestamp`
   - `vault.last_payment_timestamp = current_timestamp`
   - `vault_state = 0` (position resumes active state)
8. Inner transaction: transfer `lp_to_seize` LP tokens to admin wallet
9. `flat_fee=true, fee=2000`

**After the transaction:** the admin redeems the seized LP tokens on Tinyman, obtaining the underlying assets. The admin may keep the proceeds as protocol revenue or route them through the PSM if mUSD is needed.

**Clock reset:** `last_payment_timestamp` is set to `current_timestamp`. The borrower now has a fresh 90-day window before interest is next due. The position continues — `musd_borrowed` is unchanged.

### What Happens to the Seized LP

The LP tokens land in the admin wallet. The admin redeems them on Tinyman manually:
- For a U/ALGO LP: admin receives ~50% ALGO + ~50% $U
- The $U portion may be swapped to USDC via PSM or DEX
- The ALGO portion is liquid and easily converted

No on-chain settlement flow is required. The seized LP represents the protocol's interest revenue — it is not tracked against a debt tally. Once transferred to admin wallet, the obligation is discharged.

---

## Health-Factor Liquidation (Collateral Value Decline)

### Purpose

Protects against LP collateral losing value to the point where the borrowed mUSD is no longer adequately backed. MagnetFi v2 uses a tiered liquidation system — partial seizures for minor breaches preserve the borrower's position while protecting the protocol; full seizure is reserved for severe breaches.

### Trigger Condition

```
health_factor < 1.0
WHERE health_factor = floor(lp_value × liq_threshold_bps / 10_000) / (musd_borrowed + accrued_interest)
AND lp_value = vault.lp_amount × oracle.get_lp_price(vault.lp_pool_id) / 1_000_000
```

No waiting period. The admin may trigger immediately when health factor falls below 1.0.

### Liquidation Tiers

| Tier | Health Factor Range | LP Seizure | Position After |
|---|---|---|---|
| 1 — Partial | 0.95 ≤ HF < 1.0 | 35% of LP tokens | Continues; debt reduced; health restored |
| 2 — Partial | 0.85 ≤ HF < 0.95 | 60% of LP tokens | Continues; debt reduced; health restored |
| 3 — Full | HF < 0.85 | 100% of LP tokens | Closed |

**Tier boundary contract implementation:** boundaries must use strict inequalities, not decimal approximations. In contract code: Tier 1 = `HF_num × 100 >= HF_den × 95 AND HF_num < HF_den`; Tier 2 = `HF_num × 100 >= HF_den × 85 AND HF_num × 100 < HF_den × 95`; Tier 3 = `HF_num × 100 < HF_den × 85`. No gap, no overlap.

**Tier rationale:** pre-defined percentages allow the admin to act with a single click during fast-moving markets — no manual calculation required under pressure. Percentages are calibrated to restore health factor to ≥ 1.06 at the worst case of each tier's range.

**Tier 1 math check** (HF = 0.95, worst case):
```
LP value $7,600 → seize 35% = $2,660
Remaining LP $4,940, remaining debt $3,340
New HF = ($4,940 × 0.75) / $3,340 = 1.109 ✓
```

**Tier 2 math check** (HF = 0.85, worst case):
```
LP value $6,800 → seize 60% = $4,080
Remaining LP $2,720, remaining debt $1,920
New HF = ($2,720 × 0.75) / $1,920 = 1.063 ✓
```

**Tier 3** (HF < 0.85): position is deeply underwater. Full seizure is cleaner and faster than partial — a 60% seizure at this depth leaves too thin a margin if prices continue falling during settlement.

**LP seizure token count:**
```
lp_to_seize     = ceil(lp_amount × tier_bps / 10_000)
seized_lp_value = lp_to_seize × lp_price / 1_000_000   [mUSD equivalent at oracle price; WideRatio required]
```

The `seized_lp_value` (not `total_debt`) is what the admin must return to PSM. The borrower's remaining debt is reduced by exactly this amount. Only the seized portion is unwound — the rest of the position continues.

### Partial Liquidation Flow

`trigger_partial_liquidation(borrower_address, pool_id, tier)` — admin wallet only; tier = 1 or 2

1. Assert `vault_state != 2`
2. Assert oracle is fresh
3. Accrue interest to current timestamp; compute `total_debt = musd_borrowed + accrued_interest`
4. Compute health factor — assert it falls within the specified tier's range (strict inequalities)
5. Compute `lp_to_seize = ceil(vault.lp_amount × tier_bps / 10_000)` where `tier_bps = 3500` for tier 1 (35%) and `tier_bps = 6000` for tier 2 (60%); assert `tier` argument is 1 or 2 (reject invalid tier values)
6. Compute `seized_lp_value = lp_to_seize × lp_price / 1_000_000` [WideRatio required]
7. **All state changes before inner transactions:**
   - `vault.musd_borrowed = total_debt − seized_lp_value` ← new reduced debt
   - `vault.accrued_interest = seized_lp_value` ← **settlement counter** (repurposed in state 2)
   - `vault.lp_amount -= lp_to_seize`
   - `vault.last_accrual_timestamp = current_timestamp` (freeze; no new interest while in state 2)
   - `vault_state = 2`
8. Inner transaction: transfer `lp_to_seize` LP tokens to admin wallet
9. `flat_fee=true, fee=2000`

**Economics check (Tier 1 at HF = 0.95):**
```
total_debt $6,000 | LP value $7,600 | seize 35% = $2,660 LP tokens
seized_lp_value = $2,660 → new musd_borrowed = $3,340 | accrued_interest = $2,660 (settlement)
Remaining LP = $4,940
After settlement: musd_borrowed = $3,340, lp_amount = $4,940 → HF = 1.109 ✓
Admin paid $2,660 mUSD, received $2,660 LP. Net: zero loss. ✓
```

### Full Liquidation Flow

`trigger_full_liquidation(borrower_address, pool_id)` — admin wallet only

1. Assert `vault_state != 2`
2. Assert oracle is fresh
3. Accrue interest to current timestamp; compute `total_debt = musd_borrowed + accrued_interest`
4. Assert `HF_num × 100 < HF_den × 85` — contract enforces Tier 3 boundary
5. Compute `total_lp_value = lp_amount × lp_price / 1_000_000` [WideRatio required — see AUD-066]
6. **If `total_lp_value == 0`** (LP position rounds to zero at current oracle price — dust position): skip state 2 entirely; transfer `lp_amount` LP to admin wallet; delete vault box and return 46,500 µALGO MBR to borrower; write off `total_debt` as bad debt. `flat_fee=true, fee=3000` (outer + LP AssetTransfer + MBR Payment). Stop.
7. Compute surplus LP to return to borrower (if `total_lp_value > total_debt`):
   - `surplus_lp_tokens = floor((total_lp_value − total_debt) × 1_000_000 / lp_price)` [WideRatio required]
   - `lp_to_seize = lp_amount − surplus_lp_tokens`
8. Compute `musd_to_settle = min(total_debt, total_lp_value)` — may be less than total_debt in shortfall
9. **All state changes before inner transactions:**
   - `vault.musd_borrowed = 0`
   - `vault.accrued_interest = musd_to_settle` ← settlement counter
   - `vault.lp_amount = 0`
   - `vault_state = 2`
10. Inner transaction 1: transfer `surplus_lp_tokens` LP to borrower (skip if zero)
11. Inner transaction 2: transfer `lp_to_seize` LP to admin wallet
12. `flat_fee=true, fee=3000`

### Settlement — Returning mUSD to PSM Reserve

**Operational note:** the recommended approach is to keep ~$500 USDC in the admin wallet as a float — immediately after seizure, use the float to buy mUSD from the PSM and settle the vault in the same session. The seized LP can then be sold at the admin's discretion.

`settle_health_liquidation(borrower_address, pool_id, musd_amount)` — admin wallet only

Atomic group: AppCall + AssetTransfer (mUSD **directly to PSM contract address**)

1. Assert `vault_state == 2`
2. **Assert AssetTransfer is present in group:** ASA ID = mUSD, receiver = **PSM contract address** (`AppParam.address(psm_app_id).value`), amount = `musd_amount` exactly — prevents calling the method without actually routing mUSD to PSM; vault verifies this transfer at its own level before calling PSM
3. Assert `musd_amount ≤ vault.accrued_interest` (cannot overpay settlement counter)
4. Reduce `vault.accrued_interest -= musd_amount`
5. Call PSM `receive_musd(musd_amount)` via inner transaction — PSM verifies vault app address and updates circulating supply accounting; mUSD has already landed at PSM from step 2's outer group transfer
6. Evaluate completion:
   - If `accrued_interest > 0`: partial settlement; stay in state 2 (admin can call again)
   - If `accrued_interest > 0`: partial settlement; stay in state 2 (already covered above)
   - If `accrued_interest == 0` and `musd_borrowed > 0` and `lp_amount > 0`:
     → **Partial liq settled** — set `last_accrual_timestamp = current_timestamp`; `last_payment_timestamp = current_timestamp`; `vault_state = 0`
   - If `accrued_interest == 0` and `musd_borrowed == 0` and `lp_amount > 0`:
     → **Seized LP exactly covered all debt** (hit the cap where `seized_lp_value = total_debt`) — remaining LP is surplus. Inner transfer: return `lp_amount` LP to borrower; delete vault box; return 46,500 microALGO MBR to borrower. `flat_fee=true, fee=4000` (outer + PSM.receive_musd + LP AssetTransfer + MBR Payment).
   - If `accrued_interest == 0` and `musd_borrowed > 0` and `lp_amount == 0`:
     → **Dust-position bad debt** — remaining debt written off; delete vault box, return 46,500 microALGO MBR to borrower
   - If `accrued_interest == 0` and `musd_borrowed == 0` and `lp_amount == 0`:
     → **Full liq settled** — delete vault box, return 46,500 microALGO MBR to borrower
7. No vault closure: `flat_fee=true, fee=2000` (outer + PSM.receive_musd inner tx); vault closure branches (dust bad debt or full liq settled): `flat_fee=true, fee=3000` (outer + PSM.receive_musd + MBR Payment inner tx)

**Shortfall scenario (full liquidation where LP value < total debt):**

If LP value was insufficient to cover all debt, `musd_to_settle < total_debt`. After admin settles `musd_to_settle`, the circulating mUSD decreases by `musd_to_settle`. The PSM USDC reserve is unchanged. The core invariant (`circulating_musd ≤ psm_usdc_balance`) is **not broken** by a shortfall — PSM USDC was reserved against the vault borrow at open time and already covers all circulating mUSD including this vault's share.

What the shortfall *does* cost: `(total_debt − musd_to_settle)` mUSD remains permanently circulating with no corresponding vault ceiling restored. This is ceiling headroom loss, not an invariant breach.

**Settlement:** call `settle_health_liquidation(borrower_address, pool_id, musd_to_settle)` — the contract's settlement counter (`accrued_interest` in state 2) equals `musd_to_settle = lp_value`, and the assertion `musd_amount ≤ accrued_interest` enforces this. Passing `total_debt` instead fails this assertion and reverts.

**Optional ceiling restoration:** admin may call `deposit_usdc(total_debt − musd_to_settle)` after settlement to restore the lost ceiling headroom. The deficit USDC comes from protocol treasury reserves. See ADMIN.md emergency procedures. This is discretionary — the invariant is already satisfied without it.

**Incremental settlement:** `settle_health_liquidation` accepts any `musd_amount ≤ accrued_interest` and decrements the counter. Admin may settle in multiple calls if the float cannot cover the full seizure value at once.

**Interest realization in liquidation (P19-04).** In a health-factor liquidation the pre-liquidation accrued interest is folded into `total_debt` and retired via the seized collateral, rather than swept to `accumulated_fees` as in a normal `pay_interest`. This is **not** a loss of revenue — it is a different realization path. Settling debt with seized collateral returns mUSD to the PSM, reducing circulating supply; over the loan's full lifecycle the PSM excess (`psm_usdc_balance − circulating_musd`, withdrawable by the admin via `withdraw_usdc`) grows by exactly the interest earned. So liquidation interest is realized as **PSM overcollateralization / withdrawable USDC excess**, the conservative solvency-favoring form, rather than as mUSD in the fee counter. Crediting `accumulated_fees` here would be incorrect: no mUSD physically arrives at the vault during a liquidation, so the entry would be unbacked.

---

## LP 50/50 Split — Price Impact Advantage

When an LP position is liquidated, the underlying assets are two distinct tokens. Redeeming LP on Tinyman returns roughly 50% of each.

For a U/ALGO LP liquidation:
- Seize U/ALGO LP tokens
- Redeem on Tinyman → receive ~50% ALGO + ~50% $U
- Sell ALGO for USDC (large liquid market, minimal price impact)
- Swap $U via PSM or DEX for USDC/mUSD

**Impact:** a $10,000 LP liquidation becomes a ~$5,000 ALGO sell event and a ~$5,000 $U sell event — not a $10,000 single-asset sell. Price impact on $U is halved compared to an equivalent single-asset $U collateral liquidation.

This is a structural advantage of LP collateral. It protects $U token price stability during liquidation events and reduces the risk of a cascading liquidation spiral.

---

## Trigger Priority

If both liquidation triggers are applicable simultaneously (overdue payment AND health factor breach):

**Health-factor liquidation takes precedence.**

When health factor is below 1.0, the protocol is at risk of bad debt. That risk must be addressed first. The micro-liquidation path (collecting interest) is irrelevant if the position may become insolvent — the full health liquidation resolves the position entirely.

---

## State Guards

| Method | State 0 | State 1 | State 2 |
|---|---|---|---|
| `open_vault()` | ✓ new vault | — | — |
| `add_collateral()` | ✓ | ✓ | ✗ blocked |
| `borrow_more()` | ✓ | ✗ blocked | ✗ blocked |
| `pay_interest()` | ✓ | ✓ clears state | ✗ blocked |
| `repay_principal()` | ✓ | ✓ | ✗ blocked |
| `trigger_micro_liquidation()` | ✗ | ✓ admin | ✗ |
| `trigger_partial_liquidation()` | ✓ if HF 0.85–0.9999 | ✓ if HF 0.85–0.9999 | ✗ |
| `trigger_full_liquidation()` | ✓ if HF<0.85 | ✓ if HF<0.85 | ✗ |
| `settle_health_liquidation()` | ✗ | ✗ | ✓ admin |

---

## Risk Parameters (TBD)

| Parameter | Value |
|---|---|
| Grace period before micro-liq | 90 days |
| Micro-liq buffer | 5% (2% execution + 3% late fee) |
| Health-factor liquidation threshold | 75% (all vault types) |
| Liquidation fee (health path) | 0% — no penalty on partial or full health liquidations |

---

## Known Assumptions

**Manual execution latency:** between when a health-factor liquidation is triggered and when mUSD is returned to the PSM reserve, the circulating mUSD is still outstanding against seized (but unredeemed) LP. With the USDC float approach, this window can be closed immediately after seizure — settle the vault using the float, then sell LP at leisure.

**Admin-managed liquidation advantage:** automated public liquidators (as used in protocols like MakerDAO, Aave) must sell seized assets immediately to repay the liquidation bot. This creates forced selling at the moment of market stress — exactly when prices are worst. The admin-managed model decouples settlement timing from asset sale timing. LP can be held and sold when conditions improve, protecting $U price and maximizing recovery value.

**Shortfall not socialized:** if a health liquidation results in recovered value less than outstanding mUSD, the shortfall is absorbed by the protocol treasury. It is not spread to mUSD holders or other borrowers. At conservative LTV parameters, shortfalls require extreme and rapid LP value decline — this is considered an acceptable tail risk.

**Admin discretion on micro-liquidation timing:** the contract does not enforce a deadline after 90 days. The admin can wait indefinitely. This is intentional — some borrowers may be known entities who can be given further grace. The protocol trusts admin judgment on timing.

**Micro-liquidation escalation when interest exceeds collateral:** if `lp_to_seize > lp_amount`, the micro-liquidation assert fails — the accrued interest obligation exceeds the remaining LP collateral value (extremely rare; requires years of non-payment at low principal). In this case, the admin should escalate directly to `trigger_full_liquidation()` regardless of current HF. If HF is ≥ 1.0 (e.g., LP appreciated significantly), a special admin override path is needed — design for this edge case is deferred to contract-level security pass (Pass 3).

**Interest accrual overflow guard:** `annual_interest × seconds_elapsed / SECONDS_PER_YEAR` — the intermediate multiplication can overflow uint64 for large borrows left uninteracted for extended periods. At 100,000 mUSD borrowed at 8% APR, overflow occurs after ~7.3 years without any accrual call. The 90-day payment window prevents this in practice. As a contract-level guard: cap `seconds_elapsed` at `SECONDS_PER_YEAR` (one year); if more time has elapsed, the admin must call an explicit accrual transaction before any other vault interaction to advance interest in annual increments.

**Settlement liveness:** if a vault is stuck in state 2 for more than 1 hour with no settlement call, the monitoring system should alert. Admin should either complete settlement or, in an emergency, invoke treasury USDC deposit to fund it.

# Magnet Lending — Borrowing

## Overview

Borrowers deposit collateral and draw up to their allowed limit in the opposite asset. The primary use case is depositing $U to borrow USDC — accessing liquidity without selling a long-term position.

All loans are **overcollateralized**. No undercollateralized loans, no flash loans, no unsecured credit lines.

---

## Supported Collateral Pairs

| Collateral | Asset Borrowed | LTV | Liquidation Threshold | Buffer |
|---|---|---|---|---|
| $U | USDC | 65% | 75% | 10pp |
| USDC | $U | 75% | 80% | 5pp |

**Practical example — $U collateral:**
```
$1,000 in $U collateral  →  $650 USDC available to borrow (65% LTV)

Liquidation eligible when collateral_value × 0.75 < borrow_balance:
  collateral_value < $650 / 0.75 = $866.67
  → $U must drop ~13.3% from deposit time
```

---

## Health Factor

```
health_factor = floor(collateral_value × liquidation_threshold_bps / 10_000) / borrow_balance
```

All health factor calculations use **floor (round down)** — borderline positions are treated as risky, preventing precision exploits that might make a liquidatable position appear healthy.

**First borrow:** health factor is not evaluated during a brand new borrow (when `borrow_balance` is zero before the draw). Division by zero would occur. Health factor checks only apply to existing positions with `borrow_balance > 0`. The LTV check (`borrow_amount ≤ collateral_value × LTV`) is used instead for first borrows — and since LTV (65%) < liquidation threshold (75%) by design, any valid first borrow starts with a health factor above 1.0.

| Value | State |
|---|---|
| > 1.0 | Healthy |
| = 1.0 | Liquidation boundary |
| < 1.0 | Grace period begins (2 hours) |

---

## Integer Overflow Safety

All math uses a defined divide-before-multiply operation order. Algorand uint64 max is ~1.84 × 10^19.

**Collateral value:**
```
# Divide oracle price scaling BEFORE further multiplication
collateral_usdc = collateral_base_units × oracle_price / 1_000_000
```

**Health factor numerator:**
```
numerator = collateral_usdc × liq_threshold_bps / 10_000
# Compare numerator against borrow_balance directly
```

**Interest accrual (critical — naive order overflows):**
```
# WRONG — overflows: balance × rate_bps × blocks_elapsed
# CORRECT — divide rate scale first:
annual_interest = borrow_balance × rate_bps / 10_000
new_interest    = annual_interest × blocks_elapsed / BLOCKS_PER_YEAR
```

---

## Borrow Flow

**First deposit** — atomic group: Payment (MBR 37,300 microALGO) + AppCall + AssetTransfer

1. Contract verifies MBR payment, creates borrower box
2. Stores `collateral_amount`
3. Borrower calls `borrow(amount)` (same or separate transaction)
4. Contract asserts:
   - `liquidation_state == 0` — borrow blocked in state 1 (eligible) and state 2 (in_liquidation)
   - `collateral_amount > 0` — explicit guard; borrow impossible without collateral
   - Oracle is fresh (`last_updated` within 10 minutes)
   - `borrow_balance + new_amount ≤ floor(collateral_value × LTV_bps / 10_000)` — total debt including accrued interest cannot exceed LTV after the draw
   - Pool has sufficient available liquidity
5. Interest accrued on existing balance
6. Asset sent to borrower via inner transaction (flat_fee=true, outer fee=2000)

Collateral deposit and initial borrow can be combined into one atomic group.

---

## No Partial Collateral Withdrawal

**Collateral cannot be partially withdrawn while any debt is open.** `withdraw_collateral()` is only callable when `borrow_balance = 0`. This eliminates health factor manipulation attacks where a borrower withdraws collateral post-borrow, leaving a position that deteriorates faster than the oracle tracks.

Full repayment → full collateral return, no exceptions.

---

## Repayment Flow

Atomic group: AppCall + AssetTransfer

The contract explicitly verifies before processing:
- `liquidation_state != 2` — repay blocked in state 2 (use `cancel_liquidation()` with repayment instead)
- Transfer ASA ID matches pool's designated asset
- Transfer receiver is the pool contract address
- Transfer amount > 0

1. Contract accrues interest to current block
2. `borrow_balance` reduced by repayment amount

**Minimum balance enforcement:**
- USDC pool: 1,000,000 microUSDC (1.00 USDC)
- $U pool: 100,000 base units (1.00 $U)

If repayment leaves a balance below the minimum, the contract forces full closure: `borrow_balance` zeroed, collateral returned via inner transaction, borrower box deleted, MBR returned.

On `repay_all()`: same full closure — explicit full repayment path with collateral return in the same transaction.

**Fee requirement:** all `repay()` calls must use `flat_fee=true, fee=2000` microALGO regardless of repayment amount. A partial repayment uses only 1000 microALGO (no inner transaction), but the caller cannot know in advance whether their repayment will trigger force-close and a collateral return inner transaction. Using fee=2000 on all repay calls eliminates this ambiguity — the unused 1000 microALGO on partial repayments is acceptable waste.

**Atomic group restriction:** do not combine `repay_all()` and `deposit_collateral()` in the same atomic group. The interaction order would return collateral then re-deposit it — producing undefined state updates. Use separate transactions.

**Rate change notice:** borrow rates are adjustable by the founder without on-chain notice to borrowers. The frontend must display the current rate on every visit and alert borrowers if rates changed since their last interaction.

---

## Grace Period — Clearing on Recovery

When health factor drops below 1.0, `liquidation_eligible_timestamp` is set and `liquidation_state` transitions to `1` (eligible).

**Auto-cleared** on any interaction that restores health factor above 1.0:
- `deposit_collateral()` — asserts `liquidation_state != 2`; health re-evaluated after adding collateral
- `repay()` — asserts `liquidation_state != 2`; health re-evaluated after reducing balance

If health factor crosses back above 1.0, `liquidation_eligible_timestamp` is cleared and `liquidation_state` returns to `0`.

**Oracle staleness during collateral top-up:** if the oracle is stale when a borrower calls `deposit_collateral()`, the contract cannot compute a valid health factor. In this case the deposit is accepted (collateral added to box) and the grace period timer is cleared regardless — adding collateral is an unambiguously protective action and should never be blocked. The health factor re-evaluation is skipped when oracle is stale; the timer clears unconditionally on collateral deposit.

`liquidate()` performs a **live health factor re-check at execution time** regardless of the timestamp. Both must confirm the position is liquidatable.

---

## Collateral Withdrawal

`withdraw_collateral()` — callable only when `borrow_balance == 0` and `collateral_amount > 0`:

1. Assert `borrow_balance == 0` — debt must be fully cleared before collateral is released
2. Assert `collateral_amount > 0` — nothing to withdraw otherwise
3. Send `collateral_amount` of `collateral_asset_id` to borrower wallet via inner transaction
4. Zero `collateral_amount` in box
5. Delete borrower box, return 37,300 microALGO MBR to borrower
6. `flat_fee=true, fee=2000`

**Borrower opt-in requirement:** the borrower must be opted into `collateral_asset_id` to receive the transfer. If they have de-opted from $U (for example) after depositing it as collateral, the inner transaction will fail. The borrower must re-opt-in before calling `withdraw_collateral()`.

---

## Collateral Top-Up

`deposit_collateral(amount)` without borrowing — improves health factor, no new debt. Automatically clears grace period if health factor recovers above 1.0. Recommended action when health factor approaches 1.2.

---

## Additional Borrowing

Against existing collateral, additional draws use the same unified LTV check as initial borrows:

```
borrow_balance + new_amount ≤ floor(collateral_value × LTV_bps / 10_000)
```

This caps total outstanding debt (including all accrued interest) at the LTV limit at every draw — initial or additional. There is no separate "health factor" path for additional borrows. The LTV check is the single rule.

**Execution order:** interest is accrued first (updating `borrow_balance` to the current block), then the total debt check is evaluated. Checking before accrual would understate the true debt and allow draws that immediately exceed LTV once interest is applied.

Oracle price is re-checked at execution time of every borrow call.

---

## Box Storage

```
Borrower box:
  key:   "borrow_" + borrower_pubkey          39 bytes
  value: collateral_amount (uint64)            8 bytes
         borrow_balance (uint64)               8 bytes
         last_accrual_block (uint64)           8 bytes
         eligible_timestamp (uint64)           8 bytes
         liquidation_state (uint64)            8 bytes  ← 0=none, 1=eligible, 2=in_liquidation
         outstanding_registered (uint64)       8 bytes  ← 0=false, 1=true; prevents double pool registration
         total value:                         48 bytes
  MBR:   2500 + 400 × (39 + 48) = 37,300 microALGO
         Paid by borrower on first deposit, returned on full repayment
```

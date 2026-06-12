# Magnet Lending — Liquidation

## Overview

When a borrower's health factor drops below 1.0, their position enters a 2-hour grace period. If the borrower does not restore their health factor, the founder may manually trigger liquidation. The contract handles custody and accounting; the actual asset swap is executed manually off-chain.

Contract safety is paramount. This design intentionally minimizes automation, DEX integration, and complexity.

---

## Design Principles

- **Manual only** — no automated bot, no public liquidators
- **Minimal contract scope** — seize and track; founder swaps off-chain
- **Two-state flag** — eligible and in_liquidation are distinct states with distinct guards
- **Check-effects-interactions** — all state changes before any inner transactions
- **Live health factor re-check** — timestamp AND current health factor both required at execution
- **Cash-based settlement** — tally tracks actual proceeds, not oracle estimates
- **Atomic group required for opening** — `liquidate()` and `set_outstanding_liquidation_balance()` must be in the same atomic group
- **Bonus to founder** — 8% in collateral asset

---

## Position States

```
State 0: none            → healthy
State 1: eligible        → health_factor < 1.0, grace period running
State 2: in_liquidation  → collateral seized, settlement pending
```

**Transitions:**
```
none → eligible:          health_factor drops below 1.0
eligible → none:          borrower restores health_factor > 1.0 within grace period
eligible → in_liquidation: liquidate() called after 2 hours, live check confirms < 1.0
in_liquidation → none:    outstanding_balance = 0 (settlement complete)
```

State 2 is locked — only `deposit_liquidation_proceeds()` and `cancel_liquidation()` can act on it.

---

## Grace Period

When health factor drops below 1.0, `liquidation_eligible_timestamp` is recorded and `liquidation_state = 1`. For 2 hours the borrower can self-rescue:
- `deposit_collateral()` — add collateral
- `repay()` — reduce borrow balance

Either restoring `health_factor > 1.0` clears the timestamp and resets state to `0`.

`liquidate()` is callable only when:
```
current_time >= liquidation_eligible_timestamp + 7200  (2 hours elapsed)
AND live health_factor < 1.0                           (re-evaluated at execution)
AND liquidation_state == 1                             (eligible, not already in liquidation)
```

All three must be true. A position that recovered cannot be liquidated even if 2 hours elapsed.

---

## Required Atomic Group for Opening Liquidation

`liquidate(borrower)` and `set_outstanding_liquidation_balance(borrower_address, amount)` on the relevant pool contract **must be submitted in the same atomic group**. This eliminates the timing window where a lender could withdraw funds earmarked for settlement before the pool's outstanding balance is updated.

```
Atomic group (liquidation opening):
  Txn 0: AppCall → liquidate(borrower)                                      [pool contract]
  Txn 1: AppCall → set_outstanding_liquidation_balance(borrower, amount)    [pool contract]
```

Both succeed or both fail. The pool's withdrawal capacity is reduced atomically with the seizure.

`set_outstanding_liquidation_balance(borrower_address, amount)`:
- Asserts `borrower_box.liquidation_state == 2` — position must already be in state 2 (set by `liquidate()` in the same atomic group before this call executes)
- Asserts `amount == borrower_box.borrow_balance` — amount must match actual frozen debt
- Asserts `borrower_box.outstanding_registered == false` — prevents double-registration for the same position; set to `true` after incrementing
- **Increments** `outstanding_liquidation_balance += amount` — does not assign

`outstanding_registered` is a boolean field in the borrower box that prevents `set_outstanding_liquidation_balance()` from being called twice for the same position. It is cleared when settlement completes.

Paired decrement happens in `deposit_liquidation_proceeds()` as proceeds arrive.

Interest stops accruing on a position once `liquidation_state = 2`. The `borrow_balance` is frozen at the seized value — `last_accrual_block` is not updated after state 2 entry.

---

## Liquidation Flow

### Step 1 — On-chain: Seize

**All state changes execute before any inner transactions:**

```
1.  Assert: timestamp elapsed, live health_factor < 1.0, state == 1
2.  Assert: oracle is fresh (last_updated within 10 min)
3.  Calculate seized_amount = floor(borrow_balance × 108 / 100 / oracle_price)
    ← floor rounds borrower-favorably (seizure slightly under 108% of debt value)
4.  Calculate excess_collateral = collateral_amount − seized_amount
5.  Calculate bonus_amount = seized_amount × 8 / 108
6.  Set liquidation_state = 2                          ← state FIRST
7.  Set outstanding_balance = borrow_balance            ← frozen; interest stops accruing
8.  Zero borrower's collateral_amount in box
9.  Freeze last_accrual_block (no further interest updates in state 2)
10. Create liquidation box (23,300 microALGO MBR from founder's outer payment)
11. — THEN inner transactions (flat_fee=true, outer fee=3000 for two inners) —
12. Send excess_collateral → borrower (inner txn 1)
13. Send bonus_amount → founder wallet (inner txn 2)
14. Set `collateral_held = seized_amount − bonus_amount` in liquidation box
    ← this amount remains at the contract address for settlement
```

**Liquidation box MBR:** the founder's `liquidate()` outer transaction must include an additional 23,300 microALGO payment to fund the liquidation box. When the box is deleted at settlement completion, this amount is returned to the contract and may be swept by the founder via `collect_algo()`.

### Step 2 — On-chain: Release for Sale

Before selling, the founder must transfer the retained collateral from the contract to their wallet via `release_collateral_for_sale(borrower_address, amount)` — **admin wallet only**:

- Assert `liquidation_state == 2` for the borrower
- Assert `outstanding_balance > 0` — cannot release collateral from a fully settled position
- Assert `amount <= collateral_held`
- Transfer `amount` of `collateral_asset_id` to founder wallet via inner transaction (flat_fee=true, fee=2000)
- `collateral_held -= amount`
- Does NOT modify `outstanding_balance` — that only changes via `deposit_liquidation_proceeds()`

The founder calls this in batches to pull out collateral incrementally, sell on TinyMan, then deposit proceeds.

**Operational trust assumption:** `collateral_held` and `outstanding_balance` are decremented by different functions and have no on-chain enforced relationship. The founder could release all collateral (`collateral_held → 0`) without depositing proceeds (`outstanding_balance > 0`). At that point no on-chain collateral remains but the debt is still recorded. Lenders are exposed to the founder's operational integrity for settlement completion. This is an accepted trust assumption consistent with the protocol's overall trust model.

### Step 3 — Off-chain: Swap

Founder sells the released collateral on TinyMan or other DEX in batches, depositing USDC proceeds via `deposit_liquidation_proceeds()`.

### Step 4 — On-chain: Settle

Each `deposit_liquidation_proceeds(borrower_address, amount)` call — **admin wallet only** (atomic group: AppCall + AssetTransfer):
- Assert caller is admin wallet
- Assert `amount <= outstanding_balance` — prevents overpayment being silently credited to lenders
- Assert transfer is correct pool asset (`deposit_asset_id`), receiver is pool contract address, amount > 0
- `outstanding_balance -= amount` (cash-based — actual proceeds, not oracle estimates)
- `outstanding_liquidation_balance -= amount` — decrements per deposit, keeping utilization accurate throughout settlement
- `total_borrowed -= amount` — decrements per deposit so utilization reflects cleared debt progressively
- Pool's `total_deposits += amount` (lenders' share value increases)
- When `outstanding_balance = 0`:
  - `borrower_box.outstanding_registered = false`
  - Liquidation box deleted, 23,300 microALGO MBR returned to contract
  - Borrower box deleted, 37,300 microALGO MBR returned to borrower
  - `liquidation_state = 0` — position fully closed

---

## Cancel Liquidation

The founder can call `cancel_liquidation(borrower)` to abort a `state 2` position — for example, when the borrower negotiates a direct repayment or the liquidation was triggered in error.

**With repayment** (atomic group: AppCall `cancel_liquidation` + AssetTransfer):

The contract explicitly verifies before processing:
- Transfer ASA ID matches pool's designated asset
- Transfer receiver is the pool contract address
- Transfer amount == `outstanding_balance` exactly (no overpayment — excess would be trapped)

On success:
- `total_deposits += outstanding_balance` ← lenders made whole from repayment (same as deposit_liquidation_proceeds)
- `outstanding_liquidation_balance -= outstanding_balance` ← decrement, not zero assignment
- `total_borrowed -= outstanding_balance`
- `outstanding_balance` zeroed
- `outstanding_registered = false`
- `collateral_held` transferred directly to borrower wallet via inner transaction
- `borrow_balance` zeroed
- Liquidation box deleted, 23,300 microALGO MBR returned to contract
- Borrower box deleted, 37,300 microALGO MBR returned to borrower
- `liquidation_state = 0` — position fully closed

**Without repayment** (AppCall only):
- `outstanding_liquidation_balance -= outstanding_balance` ← decrement, not zero assignment
- `outstanding_balance` zeroed
- `outstanding_registered = false`
- `collateral_held` transferred directly to borrower wallet via inner transaction (not to box)
- Liquidation box deleted, 23,300 microALGO MBR returned to contract
- `liquidation_eligible_timestamp` reset to `current_time` — gives borrower a fresh 2-hour window
- `liquidation_state = 1` — position returns to eligible; borrower must still repay or add collateral

Resetting the timestamp on cancel-without-repayment prevents the founder from immediately re-liquidating in a loop after cancellation. The borrower gets a fresh grace period each time a cancel occurs.

`cancel_liquidation()` is callable by admin wallet only.

---

## Settlement Tally

```
Liquidation opened:              outstanding = $600.00 USDC
Founder deposits $240 proceeds → outstanding = $360.00 USDC
Founder deposits $210 proceeds → outstanding = $150.00 USDC
Founder deposits $150 proceeds → outstanding = $0.00   → closed, both boxes deleted
```

Settlement uses actual USDC deposited regardless of current oracle price. If $U price moved between seizure and settlement, the founder sells more or fewer $U to cover — the tally reflects real proceeds only.

**Seized amount rounding:** `seized_amount = floor(borrow_balance × 108 / 100 / oracle_price)`. Flooring rounds in the borrower's favor — the seizure is marginally smaller than exactly 108% of the debt value. This means the founder may recover fractionally less than the full bonus in extreme edge cases, but the discrepancy is negligible and the borrower-favoring direction is the correct rounding choice.

**Simultaneous liquidations:** the protocol supports multiple positions in `state 2` simultaneously. The pool's `outstanding_liquidation_balance` counter accumulates all active obligations. The founder must track and settle each liquidation independently — there is no on-chain enforcement of settlement order. This is an accepted operational constraint at current scale.

---

## Pool Liquidity During Liquidation

`outstanding_liquidation_balance` on the pool's global state prevents lenders from withdrawing funds committed to settlement:

```
available_liquidity = total_deposits − total_borrowed − outstanding_liquidation_balance
```

Decrements with each `deposit_liquidation_proceeds()` call, automatically restoring withdrawal capacity as settlement progresses.

---

## Both Pool Directions

| | $U Collateral → Borrow USDC | USDC Collateral → Borrow $U |
|---|---|---|
| Trigger | $U price drops | $U price rises |
| Seized | $U | USDC |
| Founder swap | Sell $U → USDC | Buy $U with USDC |
| Pool restored | USDC lending pool | $U lending pool |
| Bonus | 8% in $U → founder | 8% in USDC → founder |
| $U price impact | Minimal sell pressure | Buy pressure (positive) |

---

## Inner Transaction Fee Requirements

All contract methods that include inner ASA transfers must use fee pooling:
- Outer transaction: `flat_fee=true`, inner transactions: `fee=0`
- Outer fee = 1000 microALGO × (1 + number of inner transactions)

| Method | Inner Txns | Required Outer Fee |
|---|---|---|
| `withdraw()` | 1 (asset to lender) | 2000 microALGO |
| `repay()` | 0 or 1 (collateral if force-close) | **2000 microALGO always** |
| `repay_all()` | 1 (collateral to borrower) | 2000 microALGO |
| `deposit_liquidation_proceeds()` | 0 (state update only) | 1000 microALGO |
| `liquidate()` | 2 (excess → borrower, bonus → founder) | **3000 microALGO** |
| `release_collateral_for_sale()` | 1 (collateral → founder wallet) | 2000 microALGO |
| `cancel_liquidation` (with repayment) | 1 (collateral → borrower wallet) | 2000 microALGO |
| `cancel_liquidation` (without repayment) | 1 (collateral → borrower wallet) | 2000 microALGO |
| `withdraw_collateral()` | 1 (collateral → borrower wallet) | 2000 microALGO |
| `collect_fees()` | 1 (protocol_reserve → treasury) | 2000 microALGO |
| `collect_algo()` | 1 (ALGO → founder wallet) | 2000 microALGO |

`repay()` always requires fee=2000 regardless of whether force-close fires — the caller cannot predict which path executes. `liquidate()` fires two inner transactions and requires fee=3000.

---

## Method State Guards

Every borrower-facing method checks `liquidation_state` before executing. State 2 blocks all borrower actions — only admin settlement methods are available.

| Method | State 0 | State 1 | State 2 |
|---|---|---|---|
| `deposit_collateral()` | ✓ | ✓ self-rescue | ✗ blocked |
| `borrow()` | ✓ | ✗ blocked | ✗ blocked |
| `repay()` / `repay_all()` | ✓ | ✓ self-rescue | ✗ blocked |
| `withdraw_collateral()` | ✓ (if bal=0) | ✗ bal > 0 | ✗ bal > 0 |
| `liquidate()` | ✗ | ✓ after 2hr + HF check | ✗ |
| `set_outstanding_liquidation_balance()` | ✗ | ✗ | ✓ admin |
| `release_collateral_for_sale()` | ✗ | ✗ | ✓ admin |
| `deposit_liquidation_proceeds()` | ✗ | ✗ | ✓ admin |
| `cancel_liquidation()` | ✗ | ✗ | ✓ admin |

`borrow()` is blocked in state 1 — a borrower under a grace period cannot increase their debt. They must self-rescue via `deposit_collateral()` or `repay()` first.

---

## Risk Parameters

| Parameter | $U Collateral | USDC Collateral |
|---|---|---|
| LTV | 65% | 75% |
| Liquidation threshold | 75% | 80% |
| Grace period | 2 hours | 2 hours |
| Liquidation bonus | 8% | 8% |
| Bonus destination | Founder wallet | Founder wallet |

---

## Box Storage

```
Liquidation box (created at state 2, deleted at settlement complete):
  key:   "liq_" + borrower_pubkey        36 bytes
  value: outstanding_balance (uint64)     8 bytes
         collateral_held (uint64)         8 bytes
         total value:                    16 bytes
  MBR:   2500 + 400 × (36 + 16) = 23,300 microALGO
```

`eligible_timestamp` is not stored in the liquidation box — it lives in the borrower box and is irrelevant once state 2 is entered. Removing it saves 8 bytes and reduces MBR by ~3,200 microALGO.

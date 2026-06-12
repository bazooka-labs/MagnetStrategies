# Magnet Lending — Lending (Deposits)

## Overview

Lenders deposit USDC or $U into the corresponding pool and earn interest paid by borrowers. In return for depositing, lenders receive **pool shares** — an internal accounting unit representing their proportional claim on the pool including accrued interest. Shares appreciate over time as borrowers pay interest — no claiming required.

---

## Pool Shares (Share-Based Accounting)

Industry standard model used by Compound (cTokens), Aave (aTokens), Benqi, and Venus. Each pool maintains:

| Variable | Description |
|---|---|
| `total_deposits` | Total lender-owned asset units (principal + accrued interest, excludes protocol reserve) |
| `total_shares` | Total shares outstanding including dead shares |

**Deposit — shares minted:**
```
shares_minted = floor(deposit_amount × total_shares / total_deposits)
```

**Withdrawal — shares burned:**
```
withdrawal_amount = floor(shares_burned × total_deposits / total_shares)
```

**Rounding:** floor on all user-facing calculations — rounds against the user to prevent value extraction via repeated rounding.

---

## Pool Contract Deployment Constants

Each pool contract stores two asset IDs in global state at deployment. These are set once during `initialize()` and are never updatable:

| Key | USDC Pool | $U Pool |
|---|---|---|
| `deposit_asset_id` | USDC ASA ID | $U ASA ID |
| `collateral_asset_id` | $U ASA ID | USDC ASA ID |

All inner transactions specifying an asset transfer reference these stored IDs — never hardcoded values in logic. Both pool contracts opt into both assets before initialization so they can hold deposits and collateral simultaneously.

---

## Dead Shares — Inflation Attack Defense

The share inflation attack targets empty pools by manipulating the ratio to zero out a real depositor's shares. Defense uses **dead shares backed by a real initial deposit**:

**At contract initialization:**
1. Founder sends a small real deposit (`DEAD_AMOUNT`) of the pool asset as part of the init atomic group — all amounts are in **base units of the pool asset**: 1,000 microUSDC (= 0.001 USDC, 6 decimals) for the USDC pool; 1,000 base units (= 0.01 $U, 5 decimals) for the $U pool
2. Contract sets `total_shares = DEAD_SHARES` (e.g., 1000) and `total_deposits = DEAD_AMOUNT`
3. Dead shares are tracked in `dead_shares` global state — a permanent count that never decrements
4. No lender box is created for dead shares — they exist only in global state counters and can never be redeemed

**Effect:** the share ratio is anchored from the first moment. An inflation attack would require donating a quantity of assets proportional to `DEAD_AMOUNT × attack_target / 1` — economically infeasible for any meaningful target deposit.

**Init atomic group structure:**
```
Txn 0: AppCall → initialize()          [pool contract]
Txn 1: AssetTransfer → DEAD_AMOUNT     [deposit_asset_id to pool contract address]
```
The contract asserts `Global.group_size() == 2` to reject malformed init groups. It reads `Gtxn[1].asset_amount` for `total_deposits` and asserts `Gtxn[1].xfer_asset == deposit_asset_id`.

**Verification at init:** the `initialize()` call must be in an atomic group containing the asset transfer for `DEAD_AMOUNT`. The contract:
1. Asserts the contract account is already opted into `deposit_asset_id` — rejects if not
2. Asserts the contract account is already opted into `collateral_asset_id` — rejects if not
3. Reads `DEAD_AMOUNT` from the actual transferred amount in the atomic group (`Gtxn[transfer_index].asset_amount`), not from a hardcoded constant — the actual transferred amount becomes the initial `total_deposits` value
4. Sets `total_shares = DEAD_SHARES` and `total_deposits = actual_transferred_amount`

---

## Protocol Fee Accounting

Protocol fee is tracked on a **completely separate ledger** from lender deposits — the two never mix:

```
On each accrual:
  new_interest      = total_borrowed × rate_bps / 10_000 × blocks_elapsed / BLOCKS_PER_YEAR
  lender_portion    = new_interest × (10_000 − fee_bps) / 10_000
  protocol_portion  = new_interest − lender_portion

  total_deposits   += lender_portion      ← lenders only
  protocol_reserve += protocol_portion    ← separate counter
```

`collect_fees()` sweeps `protocol_reserve` to the treasury wallet. Zero impact on `total_deposits` or lender share values.

**The incorrect model** — adding full interest to `total_deposits` then deducting fees on collection — silently reduces lender share values on every sweep. This contract uses the correct model above.

---

## Interest Rate Model

Rates stored as adjustable global state parameters in basis points. Founder updates via `set_rates()` without redeployment.

**Rate changes take effect immediately on the next accrual.** Borrowers are not notified on-chain. The frontend must display the current rate prominently and alert borrowers if rates changed since their last visit.

**Launch parameters:**

| Parameter | USDC Pool | $U Pool |
|---|---|---|
| Base rate (0% utilization) | 0.5% APR | 0.5% APR |
| Optimal rate (at kink) | 7% APR | 7% APR |
| Max rate (100% utilization) | 100% APR | 150% APR |
| Kink point | 80% | 70% |

**Lender APY = Borrower Rate × Utilization × (1 − Protocol Fee)**

---

## Kink Mechanics

**Below kink:**
```
rate = base_rate + (utilization / kink) × (optimal_rate − base_rate)
```

**Above kink:**
```
rate = optimal_rate + ((utilization − kink) / (100 − kink)) × (max_rate − optimal_rate)
```

USDC pool above kink example:
```
At 80%: 7.0%    At 90%: 53.5%    At 100%: 100.0%
```

---

## `total_borrowed` Tracking

`total_borrowed` is the pool's running total of outstanding debt across all borrowers. Every change must be explicit:

| Event | Operation |
|---|---|
| `borrow(amount)` | `total_borrowed += amount` |
| `repay(amount)` partial | `total_borrowed -= amount` |
| `repay_all()` / force-close | `total_borrowed -= borrow_balance` (full remaining balance including accrued interest) |
| Liquidation settlement complete (`outstanding_balance = 0`) | `total_borrowed -= outstanding_balance` (the frozen debt at time of seizure) |

`total_borrowed` drives three critical calculations: interest accrual, utilization rate, and available withdrawal liquidity. An incorrect value propagates errors into all three.

**Known approximation:** `total_borrowed` is only updated on explicit borrower interactions. Between interactions, individual `borrow_balance` values grow via per-block interest accrual, but `total_borrowed` does not update automatically. This means pool-level interest accrual (`total_borrowed × rate`) is slightly understated between interactions — lenders earn fractionally less than exact interest until the next borrower interaction closes the gap. This approximation is accepted at current scale. The alternative (Compound's borrow index model) is significantly more complex and not warranted yet.

---

## Interest Accrual

Safe multiplication order to prevent uint64 overflow (max ~1.84 × 10^19):

```
blocks_elapsed    = current_block − last_accrual_block

# Divide rate scaling FIRST, then multiply by block count
annual_interest   = total_borrowed × rate_bps / 10_000
new_interest      = annual_interest × blocks_elapsed / BLOCKS_PER_YEAR

lender_portion    = new_interest × (10_000 − fee_bps) / 10_000
protocol_portion  = new_interest − lender_portion

total_deposits   += lender_portion
protocol_reserve += protocol_portion
last_accrual_block = current_block
```

**Live utilization note:** `total_deposits` grows between interactions as interest accrues silently. Displayed utilization (`total_borrowed / total_deposits`) is only accurate at the last interaction block. The frontend must simulate accrual up to the current block to show live utilization.

---

## Deposit Flow

**First deposit** — atomic group: Payment (MBR) + AppCall + AssetTransfer
1. Contract verifies MBR payment covers lender box cost (20,500 microALGO)
2. Creates lender box
3. Accrues interest
4. Mints shares, stores in lender box

**Subsequent deposits** — atomic group: AppCall + AssetTransfer (box already exists)

---

## Withdrawal Flow

1. Lender calls `withdraw(shares)` or `withdraw_all()`
2. Contract accrues interest
3. Contract checks available liquidity:
   ```
   available = total_deposits − total_borrowed − outstanding_liquidation_balance
   ```
4. `withdrawal_amount = floor(shares × total_deposits / total_shares)`
5. Rejected if `withdrawal_amount > available`
6. Shares burned, asset sent via inner transaction (flat_fee=true, outer fee=2000)
7. `withdraw_all()`: box deleted, 20,500 microALGO MBR returned

**Lenders cannot withdraw funds committed to active liquidations.** `outstanding_liquidation_balance` is a running total of all active settlements — it increments when a liquidation opens and decrements as settlement proceeds are deposited. Multiple simultaneous active liquidations are supported correctly because the counter accumulates all outstanding obligations rather than tracking a single position.

---

## Outstanding Liquidation Balance

When a liquidation is opened, the admin wallet calls `set_outstanding_liquidation_balance(borrower_address, amount)` on the affected pool contract **in the same atomic group as `liquidate()`**. This ensures lender withdrawal capacity is correctly reduced from the moment the liquidation is triggered — no timing window where a lender can withdraw earmarked funds.

`set_outstanding_liquidation_balance()` **increments** the pool counter (`outstanding_liquidation_balance += amount`) — it does not assign. This correctly handles multiple simultaneous active liquidations. The contract asserts `amount == borrower_box.borrow_balance` to prevent the admin from setting an arbitrary value.

As the founder deposits settlement proceeds via `deposit_liquidation_proceeds()`, `outstanding_liquidation_balance` decrements by the amount deposited. When all active settlements are complete it returns to zero and full withdrawal capacity is restored.

---

## Adjustable Parameters

| Key | Initial Value | On-Chain Bounds | Description |
|---|---|---|---|
| `base_rate_bps` | 50 | 0–5000 | 0.5% APR |
| `optimal_rate_bps` | 700 | 0–50000 | 7% APR |
| `max_rate_bps` | 10000 / 15000 | 0–50000 | 100% / 150% APR |
| `kink_bps` | 8000 / 7000 | 1–9500 | 80% / 70% utilization |
| `protocol_fee_bps` | 1000 | 0–5000 | 10% of interest |
| `oracle_app_id` | set at deployment | — | Updatable by admin wallet only |

`set_rates()` asserts all values are within their on-chain bounds before applying and enforces ordering:
```
Assert base_rate_bps ≤ optimal_rate_bps ≤ max_rate_bps
```
This prevents the kink model from producing rates that decrease above the kink (which would occur if `optimal_rate > max_rate`). Bounds and ordering are enforced at the contract level — they cannot be bypassed even by the admin wallet.

---

## Protocol Fee

- **10%** of all borrower interest → `protocol_reserve`
- Founder calls `collect_fees()` to sweep to treasury wallet (flat_fee=true, fee=2000 — inner ASA transfer)
- Zero impact on lender shares

## ALGO Management

The pool contract accumulates ALGO from: deployment funding, liquidation box MBRs returned on settlement completion, and fee rounding from transactions.

`collect_algo()` — admin wallet only. Sweeps contract ALGO balance above a **minimum operational reserve of 1,000,000 microALGO (1 ALGO)** to the founder wallet. The reserve ensures the contract always has ALGO available for future box creations and inner transaction fees. Sweeping below this minimum is rejected.

**The 1 ALGO minimum is a floor, not a target.** At higher TVL with more simultaneous borrowers and liquidations, the contract may need more ALGO on hand. Monitor the contract ALGO balance regularly and top up proactively — each borrower box creation costs 37,300 microALGO and each liquidation box costs 23,300 microALGO from the contract's balance.

---

## Box Storage

```
Lender box:
  key:   "lend_" + lender_pubkey        37 bytes
  value: shares (uint64)                 8 bytes
  MBR:   2500 + 400 × (37 + 8)  = 20,500 microALGO
         Paid by lender on first deposit, returned on withdraw_all()
```

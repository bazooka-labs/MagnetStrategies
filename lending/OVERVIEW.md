# Magnet Lending — Overview

## What is Magnet Lending?

Magnet Lending is an overcollateralized lending and borrowing protocol built on Algorand, centered around USDC and the Magnet token ($U). It gives $U holders a way to access USDC liquidity without selling their position, and gives USDC holders a way to earn yield by providing capital to the protocol.

This is a capital efficiency tool first. The primary use case is depositing $U as collateral to borrow USDC — hold your long-term position, unlock liquidity, repay on your own terms.

---

## Two-Pool Architecture

| Pool | Deposit Asset | Borrow Asset | Primary Use Case |
|---|---|---|---|
| USDC Pool | USDC | USDC | Earn yield; borrow USDC against $U collateral |
| $U Pool | $U | $U | Earn yield; borrow $U against USDC collateral |

Each pool is an independent contract. Interest paid by borrowers flows to lenders minus a 10% protocol fee.

---

## How It Works

```
Lender deposits USDC or $U
    → receives pool shares representing proportional claim
    → earns interest passively as shares appreciate
    → withdraws at any time (subject to pool liquidity)

Borrower deposits collateral
    → protocol values collateral via oracle price feed
    → draws up to LTV limit in opposite asset
    → interest accrues per block
    → repays at any time to reclaim collateral

If health factor drops below 1.0
    → 2-hour on-chain grace period (borrower can self-rescue)
    → after 2 hours, founder may trigger liquidation
    → collateral seized atomically with pool liquidity lock
    → excess collateral + bonus returned immediately
    → founder sells minimum collateral off-chain in batches
    → deposits proceeds until settlement tally reaches zero
    → lenders restored, liquidation closed
```

---

## Component Architecture

```
Oracle Contract              ← $U/USDC price feed (app ID stored in pool global state)
    ↕                           oracle bot wallet: update_price() only (hot)
    ↕                           admin wallet: all other operations (hardware)
USDC Pool Contract           ← independent, references oracle by stored app ID
    ├── deposit / withdraw
    ├── borrow / repay / deposit_collateral
    ├── liquidate / deposit_liquidation_proceeds / cancel_liquidation
    └── set_outstanding_liquidation_balance (admin only)
$U Pool Contract             ← same interface, same oracle reference
    └── (identical methods)
Founder                      ← monitors health factors, triggers liquidation atomically,
                                executes off-chain swap, deposits settlement proceeds
```

---

## Design Principles

- **Overcollateralized only** — no undercollateralized loans, no flash loans
- **Contract safety above all** — minimal scope, no DEX integration, no automation beyond price feed
- **Manual liquidation** — founder-triggered, 2-hour on-chain grace period, forgiving by design
- **Conservative LTV ratios** — sized for $U's current liquidity depth
- **Adjustable parameters** — rates, LTV, fees, oracle address in global state; no redeployment needed
- **Atomic liquidation opening** — seize and pool liquidity lock happen in the same transaction group
- **Revenue to protocol** — 10% interest fee to treasury; 8% liquidation bonus to founder

---

## Security Architecture

Full security review completed across two passes before finalizing the architecture.

| Risk | Protection |
|---|---|
| Oracle key compromise | Separate bot wallet (price only); on-chain 50% deviation guard |
| Admin redirecting oracle | Oracle app ID in global state; admin is hardware-secured |
| Share inflation attack | Dead shares backed by real init deposit; founder initial funding |
| Protocol fee accounting bug | Separate ledgers — protocol_reserve never mixed with total_deposits |
| Integer overflow | Defined divide-before-multiply order for all math |
| Borrow without collateral | `Assert(collateral_amount > 0)` guard |
| Partial collateral withdrawal | Blocked — released only on full repayment |
| Double liquidation | Two-state flag; state 2 blocks re-entry |
| Liquidating recovered position | Live health factor re-check AND timestamp both required |
| Grace period not cleared | Auto-cleared on any interaction restoring health_factor > 1.0 |
| Lender withdrawal during settlement | `outstanding_liquidation_balance` reduces available liquidity |
| Timing gap on outstanding balance | Liquidate + set_outstanding_balance in same atomic group |
| Settlement price movement | Cash-based tally — actual proceeds deposited, not oracle estimates |
| Cancel liquidation ambiguity | Two paths: with repayment (state 0) or without (state 1) |
| Dust positions | Minimum borrow threshold; sub-threshold repayment forces full close |
| Check-effects-interactions | All state changes before any inner transactions |
| Inner transaction fees | flat_fee=true, outer fee covers all inners; documented per method |
| MBR funding | Users fund their own boxes via payment in atomic group |
| Dead shares burn address | Tracked in global state counters — no address needed, unredeemable |
| Oracle uptime | Documented as protocol safety dependency; stale oracle blocks liquidations |
| Both pools same oracle | Deployment checklist verification required |
| Oracle first post (current_price=0) | Deviation guard skipped on first post only; enforced on all subsequent |
| repay/cancel asset transfer spoofing | Explicit ASA ID, receiver, amount assertions before processing |
| liquidate() fee underpayment | fee=3000 required (two inner txns); documented per-method fee table |
| set_rates() extreme values | On-chain bounds enforced: max_rate ≤ 50,000 bps, kink ≤ 9,500 bps |
| set_outstanding_balance arbitrary value | Asserts amount == borrower borrow_balance; increments not assigns |
| cancel_liquidation timestamp stale | Timestamp reset to current_time on cancel-without-repayment |
| cancel_liquidation excess repayment | Assert exact match (amount == outstanding_balance) |
| deposit_liquidation_proceeds overpayment | Assert amount <= outstanding_balance |
| Multiple simultaneous liquidations | Increment/decrement counter handles multiple correctly |
| Interest accrues in state 2 | Frozen at seizure — last_accrual_block not updated in state 2 |
| Liquidation box MBR funding | Founder pays 26,500 microALGO in liquidate() outer txn |
| Both boxes deleted on settlement | Liquidation box + borrower box both deleted when outstanding = 0 |
| Seized amount rounding | Floor rounds borrower-favorably; documented and confirmed correct |
| Oracle stale during collateral top-up | Deposit accepted, grace period cleared unconditionally |
| Additional borrow accrual order | Interest accrued before post-draw health factor check |
| ASA opt-in before pool init | Deployment checklist enforces optin_asa() before initialize() |
| Haystack quote units | amount=100,000 base units (1 $U); verify against Haystack API |
| DEAD_AMOUNT units | Explicitly base units: 1,000 microUSDC / 1,000 $U base units |
| total_borrowed not tracked | All four update points documented; known approximation noted |
| Each pool needs two ASA opt-ins | Deployment checklist updated: both assets per pool |
| cancel_liquidation clears vs decrements | Must decrement outstanding_liquidation_balance, not clear |
| repay() force-close fee ambiguity | Always fee=2000 on all repay() calls |
| TinyMan two-hop unit mismatch | Explicit decimal normalization math in ORACLE.md |
| total_borrowed understated | Documented as known approximation; Compound index not warranted |
| Liquidation box eligible_timestamp unused | Removed; box reduced to 16 bytes, MBR 23,300 microALGO |
| repay_all + deposit_collateral combined | Documented: do not combine in same atomic group |
| cancel-with-repayment two-step | Frontend note: borrower must call withdraw_collateral() separately |
| set_outstanding_balance double-call | Assert liquidation_state==2 + outstanding_registered==false |
| Pool holds two ASAs | deposit_asset_id + collateral_asset_id stored as deployment constants |
| total_borrowed per-deposit decrement | Decremented on each deposit_liquidation_proceeds() call |
| Health factor first borrow divide-by-zero | Documented: HF not evaluated on first borrow; LTV check used instead |
| TinyMan zero price | Bot asserts u_price_algo > 0 before using fallback |
| collect_fees() fee missing | Added to fee table: fee=2000 |
| collect_algo() undefined | Defined in LENDING.md with 1 ALGO minimum reserve |
| cancel_liquidation box deletion | Both cancel paths delete liquidation box and return MBR |
| total_borrowed decrement in settlement | Decrements progressively per deposit, not only at completion |
| Liquidation box eligible_timestamp removed | Box reduced to 16 bytes, MBR 23,300 microALGO |
| Borrower box outstanding_registered field | Added; prevents double pool registration; box now 48 bytes, MBR 37,300 microALGO |
| cancel_liquidation collateral to wallet | Sends directly to borrower wallet, not back to box |
| initialize() asserts both opt-ins | Contract rejects init if not opted into both assets |
| withdraw_collateral() defined | Full method spec in BORROWING.md including opt-in requirement |
| collateral_held set explicitly | Set in seize step 14 of liquidate() |
| deposit_liquidation_proceeds admin-only | Restricted to admin wallet; borrower_address param added |
| Dead shares from actual transferred amount | total_deposits set from Gtxn amount, not constant |
| release_collateral_for_sale() missing | Added to LIQUIDATION.md; step 2 of settlement flow |
| initialize() group structure | Asserts group_size==2; reads Gtxn[1].asset_amount |
| collateral release vs settlement trust | Documented as accepted operational trust assumption |
| Additional borrow LTV inconsistency | Unified: all borrows check borrow_balance + new_amount ≤ LTV |
| cancel_liquidation total_deposits missing | Added total_deposits += outstanding_balance to with-repayment flow |
| release_collateral_for_sale outstanding guard | Assert outstanding_balance > 0 before releasing |
| Settlement step numbering | Corrected: 1 Seize, 2 Release, 3 Swap, 4 Settle |
| borrow() blocked in state 1 and 2 | Assert liquidation_state == 0 in borrow flow |
| deposit_collateral() / repay() blocked in state 2 | Assert liquidation_state != 2 in both methods |
| set_rates() ordering assertion | Assert base ≤ optimal ≤ max to prevent inverted kink curve |
| collect_algo() minimum reserve clarified | 1 ALGO is floor not target; monitor and top up proactively |
| Method state guard table | Full table in LIQUIDATION.md |
| Security review (ten passes) | Complete |

---

## Revenue Model

| Source | Amount | Destination |
|---|---|---|
| Borrower interest | 10% protocol fee | Magnet Strategies treasury |
| Liquidation bonus | 8% of debt in collateral asset | Founder wallet |

---

## Deployment Checklist

Order matters — do not skip steps or reorder:

- [ ] Deploy oracle contract
- [ ] Deploy USDC pool contract
- [ ] Deploy $U pool contract
- [ ] Call `optin_asa(USDC)` on USDC pool contract ← holds USDC (deposits) + $U (collateral)
- [ ] Call `optin_asa($U)` on USDC pool contract ← must opt into BOTH assets before init
- [ ] Call `optin_asa($U)` on $U pool contract ← holds $U (deposits) + USDC (collateral)
- [ ] Call `optin_asa(USDC)` on $U pool contract ← must opt into BOTH assets before init
- [ ] Call `initialize()` on USDC pool — atomic group includes DEAD_AMOUNT USDC transfer
- [ ] Call `initialize()` on $U pool — atomic group includes DEAD_AMOUNT $U transfer
- [ ] Verify dead shares minted in global state on both pools
- [ ] Set oracle app ID on both pool contracts (must match)
- [ ] Verify both pool contracts reference the same oracle app ID
- [ ] Post first oracle price (deviation guard skipped on first post)
- [ ] Fund both pools with real initial liquidity (founder deposit)
- [ ] Oracle bot wallet funded, running, alerting configured (5-min interval)
- [ ] Admin wallet on hardware device, oracle bot wallet separate key
- [ ] Monitoring active on oracle bot uptime — stale oracle blocks liquidations

---

## Status

| Component | Status |
|---|---|
| Architecture design | Complete |
| Security review (ten passes) | Complete |
| Oracle contract | Not started |
| Lending pool contracts | Not started |
| Frontend integration | Not started |

---

## Further Reading

- [Oracle Design](./ORACLE.md)
- [Lending](./LENDING.md)
- [Borrowing](./BORROWING.md)
- [Liquidation](./LIQUIDATION.md)

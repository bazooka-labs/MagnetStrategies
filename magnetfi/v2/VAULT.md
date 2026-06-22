# MagnetFi v2 — Vault

## What Is the Vault?

The vault is the borrowing engine of MagnetFi v2. Users deposit Tinyman LP tokens as collateral and receive mUSD loans against the value of their position. The vault tracks each borrower's collateral, outstanding principal, and accrued interest. Repayment is interest-only on a quarterly schedule — borrowers never have to repay principal to keep the position open.

All vault borrowing is overcollateralized. No undercollateralized positions, no flash loans.

---

## Supported Vault Types

Each vault type corresponds to a specific Tinyman LP pool. Risk parameters differ by pair.

| Vault Type | LP Pair | LTV | Liquidation Threshold | LP Buffer at Max LTV | Interest Rate (APR) |
|---|---|---|---|---|---|
| U/USDC LP | $U + USDC | 65% | 75% | ~13% LP drop (~27% $U move) | ~5% |
| U/ALGO LP | $U + ALGO | 60% | 75% | ~20% LP drop | ~8% |
| U/tALGO LP | $U + tALGO (liquid staked) | 60% | 75% | ~20% LP drop | ~8% |
| U/wBTC LP | $U + wBTC | 60% | 75% | ~20% LP drop | ~8% |

**LTV:** the max mUSD a user can borrow as a fraction of their LP position value.
**Liquidation threshold:** the collateral ratio at which health factor hits 1.0 and admin may liquidate.
**LP buffer:** how far the LP position must fall from open before liquidation is eligible (at max LTV).
**Interest rate:** annual interest rate on outstanding mUSD principal.

**Parameter rationale:** all vaults use a uniform 75% liquidation threshold. A lower threshold triggers earlier but with more remaining collateral cushion — important for admin-managed liquidation where settlement takes time. U/USDC LP allows 65% LTV because USDC stabilizes half the position, requiring a ~27% $U move before liquidation. All other pairs use 60% LTV — ALGO, tALGO, and wBTC are all volatile assets where the additional LTV headroom provides meaningful admin response runway and accounts for TWAP oracle lag.

---

## Borrower Position (Vault Box State)

Each borrower has a vault box per LP type. A borrower with U/ALGO LP and U/USDC LP holds two independent vault boxes — one per pool.

| Field | Type | Description |
|---|---|---|
| `lp_amount` | uint64 | LP tokens held as collateral (base units) |
| `lp_pool_id` | uint64 | Tinyman pool app ID — identifies vault type |
| `musd_borrowed` | uint64 | Principal mUSD outstanding (base units, 6 dec) |
| `accrued_interest` | uint64 | Interest accumulated since last payment (mUSD base units); repurposed as settlement counter in state 2 |
| `rate_bps` | uint64 | Interest rate locked at vault open time (basis points) |
| `last_accrual_timestamp` | uint64 | Unix timestamp of last interest accrual |
| `last_payment_timestamp` | uint64 | Unix timestamp of last interest payment |
| `vault_state` | uint64 | 0=active, 1=payment_overdue, 2=in_liquidation |

```
Vault box:
  key:   "vault_" + borrower_pubkey (32 bytes) + pool_id (8 bytes, uint64 big-endian)  →  46 bytes
  value: 8 × uint64                                                                     →  64 bytes
  MBR:   2500 + 400 × (46 + 64) = 46,500 microALGO
         Paid by borrower at vault creation, returned when vault is fully closed
```

**Multi-vault support:** the `pool_id` suffix in the box key allows a single wallet to hold one vault per supported LP type. Each vault is independent — separate collateral, debt, rate lock, and payment clock.

**Rate lock:** `rate_bps` is copied from the current global rate for that vault type at the moment `open_vault()` is called. All subsequent interest accruals for this position use the stored `rate_bps`, not the current global rate. Admin rate adjustments apply only to new vaults opened after the change.

---

## Interest-Only Repayment Model

### How Interest Accrues

Interest accrues by real-world time (unix seconds) against the outstanding principal:

```
SECONDS_PER_YEAR  = 31_536_000   [365 days × 24 × 60 × 60]
seconds_elapsed   = current_timestamp − last_accrual_timestamp
annual_interest   = musd_borrowed × vault.rate_bps / 10_000   [uses position's locked rate]
period_interest   = annual_interest × seconds_elapsed / SECONDS_PER_YEAR

accrued_interest       += period_interest
last_accrual_timestamp  = current_timestamp
```

Interest is not compounded into the principal. `musd_borrowed` stays constant until the borrower voluntarily repays principal. Only `accrued_interest` grows over time.

**Why timestamp-based (not block-based):** using actual seconds means the stated APR (e.g., 8%) is accurate regardless of Algorand's block cadence. A block-based system drifts if network block time changes — borrowers would pay more or less than the advertised rate without any contract update. Timestamp-based is also consistent with `last_payment_timestamp` already in the vault box, making the entire time-tracking system uniform.

**Wide math requirement:** Multiple intermediate products in this contract overflow uint64 for realistic vault sizes and must use AVM `mulw`/`divw` opcodes (algopy: `WideRatio`):
- `annual_interest × seconds_elapsed` — overflows for borrows above ~60M mUSD at 8% APR with a year elapsed; use `WideRatio(annual_interest, seconds_elapsed, SECONDS_PER_YEAR)`
- `lp_amount × oracle.price_per_lp` (lp_value) — overflows for ~$10M+ LP positions at typical oracle price scales; use `WideRatio(lp_amount, oracle_price, 1_000_000)`
- `lp_value × liq_threshold_bps` and `lp_value × ltv_bps` — overflow at the same scale; use `WideRatio(lp_value, bps, 10_000)`

This is a **contract implementation requirement** — standard uint64 arithmetic will produce incorrect or panicking results for large vaults.

**Seconds cap guard:** if `seconds_elapsed > SECONDS_PER_YEAR`, cap at `SECONDS_PER_YEAR` and require a second accrual call for the remainder. The 90-day payment window prevents this in normal operation.

**Timestamp monotonicity:** `seconds_elapsed = current_timestamp − last_accrual_timestamp` is always ≥ 0 because Algorand's `Global.LatestTimestamp` is monotonically non-decreasing across blocks. This Algorand-specific invariant is relied upon — contracts migrated to other runtimes must explicitly guard against timestamp regression (negative elapsed time causing uint64 underflow).

### Quarterly Payment

Every 90 days, the borrower must pay at minimum the full `accrued_interest` balance. After a successful interest payment:
- `accrued_interest` is zeroed
- `last_payment_timestamp` is updated to current time
- Clock resets — the next 90-day window starts from this moment
- `vault_state` returns to `0` if it was `1`

The borrower may pay more than the interest minimum to reduce principal. Paying less than `accrued_interest` is rejected.

### Grace Period

After **90 days with no payment**, `vault_state = 1` (payment overdue) and the admin may trigger a micro-liquidation at any time. The borrower can still pay and reset the clock at any time before the admin acts.

Interest continues accruing for every block the position sits unpaid. When the admin eventually triggers micro-liquidation — whether at day 90 or later — the seizure covers all accrued interest at that moment. The clock resets from the execution timestamp, not from day 90. Admin holds discretion on timing; known borrowers may receive extended grace.

---

## Payment Flow

**Note on `pool_id` argument:** every vault method that operates on a specific borrower's vault box requires `pool_id` as an explicit argument. The contract uses it to construct the box key `"vault_" + caller_pubkey + pool_id` (or `borrower_pubkey + pool_id` for admin methods). The caller must specify which LP vault type they're operating on.

**Interest payment only:**

Atomic group: AppCall `pay_interest(pool_id)` + AssetTransfer (mUSD to vault contract address)
[Lazy check: if `current_timestamp >= last_payment_timestamp + 90 days`, set `vault_state = 1` before any other logic — state may be stale if no vault interaction has occurred since the window expired]
1. Assert `vault_state != 2` — blocked while health liquidation settlement is pending
2. Assert AssetTransfer ASA ID = mUSD, receiver = vault contract address, amount > 0
3. **Accrue interest to current timestamp first** (updates `accrued_interest` and `last_accrual_timestamp`)
4. Assert `transfer.amount >= accrued_interest` — partial interest payments rejected; checked AFTER accrual to avoid underflow
5. Save `interest_due = accrued_interest`; compute `change = transfer.amount − interest_due` — overpayment amount
6. Zero `accrued_interest`
7. **Interest mUSD stays in vault contract** — add `interest_due` to `accumulated_fees` counter; NOT forwarded to PSM
8. If `change > 0` (overpayment — borrower wants to reduce principal):
   - Reduce `musd_borrowed` by `change`
   - Issue inner tx 1: AssetTransfer mUSD from vault → PSM address, amount = `change` (physically routes excess to PSM)
   - Issue inner tx 2: AppCall `PSM.receive_musd(change)` (PSM updates circulating supply accounting)
   - If `musd_borrowed == 0` after reduction: trigger full vault closure (inner tx 3: AssetTransfer LP → borrower; inner tx 4: Payment 46,500 µALGO MBR → borrower)
   - Without closure: `flat_fee=true, fee=3000` (outer + 2 inner txs)
   - With vault closure: `flat_fee=true, fee=5000` (outer + 4 inner txs)
9. Update `last_payment_timestamp = current_timestamp`
10. If `vault_state == 1`: reset to `0`
11. If no overpayment: `flat_fee=true, fee=1000`

**Why interest stays in vault (not PSM):** the admin collects interest as mUSD and deploys it at discretion — either converting to USDC and depositing into PSM (grows ceiling) or deploying as protocol-owned DEX liquidity. Auto-forwarding to PSM removes this flexibility. Circulating mUSD is unchanged when interest is paid (mUSD moves from borrower to vault — still circulating until admin deposits to PSM).

**Single-call full repayment:** borrowers clearing both interest and principal send `accrued_interest + musd_borrowed` as a single `pay_interest()` overpayment. Interest portion stays in vault; excess is routed to PSM as principal reduction. No second transaction needed.

**Principal repayment (partial or full):**

`repay_principal(pool_id)` — atomic group: AppCall + AssetTransfer (mUSD directly to PSM)
[Lazy check: if `current_timestamp >= last_payment_timestamp + 90 days`, set `vault_state = 1` before any other logic — state may be stale if no vault interaction has occurred since the window expired]
1. Assert `vault_state != 2`
2. Assert AssetTransfer in group: ASA ID = mUSD, receiver = **PSM contract address** (`AppParam.address(psm_app_id).value`), amount > 0
3. **Accrue interest to current timestamp**
4. Assert `accrued_interest == 0` — interest must be fully cleared before any principal reduction; this is a hard precondition, not group-based
5. Assert `repayment amount ≤ musd_borrowed` — explicit guard against over-repayment; without this the uint64 subtraction below would panic with an opaque AVM error
6. Reduce `musd_borrowed` by repayment amount
7. Call PSM `receive_musd(amount)` via inner transaction — PSM verifies vault app address and updates circulating supply accounting
8. If `musd_borrowed == 0`: trigger full vault closure (return collateral, delete box)

Fee: without vault closure: `flat_fee=true, fee=2000` (outer + PSM.receive_musd inner tx); with vault closure: `flat_fee=true, fee=4000` (outer + PSM.receive_musd + LP→borrower AssetTransfer + MBR Payment)

**Why mUSD goes to PSM directly (not vault):** PSM tracks actual ASA balances (no counters). For PSM's mUSD balance to increase — and thus circulating mUSD to decrease — the tokens must physically arrive at PSM's address. Routing mUSD through the vault first means PSM's balance never changes and circulating supply never decreases, breaking the invariant.

**Single-call full repayment path:** borrowers who want to clear both interest and principal in one transaction use `pay_interest()` with an overpayment. Any amount above `accrued_interest` is automatically routed to principal reduction (step 6 of `pay_interest()`). This covers the full repayment case without requiring group introspection in `repay_principal()`.

**Full vault closure:**
- All accrued interest cleared (sits as `accumulated_fees` in vault)
- `musd_borrowed == 0`
- Inner transaction: return all LP collateral to borrower wallet
- Delete vault box, return 46,500 microALGO MBR to borrower

**Fee collection:**

`collect_fees()` — admin wallet only
1. Assert `Txn.sender == Global.creator_address`
2. Assert `accumulated_fees > 0`
3. Inner transaction: transfer `accumulated_fees` mUSD to admin wallet
4. Zero `accumulated_fees`
5. `flat_fee=true, fee=2000`

Admin decides what to do with swept mUSD: hold for DEX liquidity, convert to USDC via PSM (`redeem_musd` at 0.99:1), or deposit back to PSM to grow vault ceiling.

---

## Open Vault (First Deposit + Borrow)

**Atomic group: Payment (MBR) + AppCall `open_vault(pool_id, borrow_amount)` + AssetTransfer (LP tokens)**

1. Assert vault box for `(caller, pool_id)` does not already exist
2. Assert payment covers vault box MBR (46,500 microALGO)
3. Assert AssetTransfer ASA ID = `lp_asa_id_[pool_id]` (correct LP token for this vault type)
4. Assert `lp_pool_id` is in supported pool whitelist
5. Assert `rate_bps_[pool_id] > 0` — rejects vault opens against pools where admin has not yet called `set_rate()`; prevents accidentally creating 0%-interest vaults if `set_lp_asa_id` was called without `set_rate`
6. Create vault box; store `lp_amount`, `lp_pool_id`; set `rate_bps = rate_bps_[pool_id]` — rate is locked at vault creation for both the borrow and deferred-draw paths; omitting this in the deferred-draw branch would leave `rate_bps = 0`, causing `borrow_more()` to accrue interest at 0% for the life of the position
6. Set `musd_borrowed = 0`, `accrued_interest = 0`, `vault_state = 0`
7. Set `last_accrual_timestamp = current_timestamp`, `last_payment_timestamp = current_timestamp`
8. **If `borrow_amount == 0`:** skip oracle check and LTV calculation — vault opened with deferred draw ✓
9. **If `borrow_amount > 0`:**
   - Assert oracle is fresh
   - Compute `lp_value = lp_amount × oracle.price_per_lp / 1_000_000`
   - Compute `max_borrow = floor(lp_value × ltv_bps_[pool_id] / 10_000)`
   - Assert `borrow_amount ≤ max_borrow`
   - Set `musd_borrowed = borrow_amount`
   - Call PSM `issue_musd(caller, borrow_amount)` via inner transaction
   - `flat_fee=true, fee=3000` — covers: vault outer execution (1000) + inner AppCall to PSM.issue_musd (1000) + PSM's inner AssetTransfer to borrower (1000)

**Deferred draw:** opening with `borrow_amount = 0` deposits collateral and creates the vault box without any mUSD minted. Borrower calls `borrow_more()` later when ready. Oracle is not consulted at open time in this path. Fee: `flat_fee=true, fee=1000` (outer only; no inner transactions).

---

## Adding Collateral

`add_collateral(pool_id)` — atomic group: AppCall + AssetTransfer (LP tokens)
[Lazy check: if `current_timestamp >= last_payment_timestamp + 90 days`, set `vault_state = 1` before any other logic — state may be stale if no vault interaction has occurred since the window expired]
1. Assert vault exists and `vault_state != 2`
2. Assert AssetTransfer ASA ID = `lp_asa_id_[vault.lp_pool_id]` — must match this vault's LP token exactly; prevents wrong-pool LP tokens inflating collateral value
3. Accrue interest to current timestamp
4. Add LP tokens to `lp_amount`
5. `flat_fee=true, fee=1000` — no inner transactions

`vault_state` is never modified by `add_collateral()` beyond the lazy overdue check. Adding collateral does not pay interest and cannot clear a payment-overdue status. Only `pay_interest()` resets state 1.

Collateral top-up is accepted regardless of oracle freshness — it is an unambiguously protective action.

---

## Additional Borrowing

`borrow_more(pool_id, amount)` — AppCall only
[Lazy check: if `current_timestamp >= last_payment_timestamp + 90 days`, set `vault_state = 1` — **must run before step 2**; if vault is overdue but `vault_state` was not yet updated on-chain, the stale `vault_state = 0` would pass step 2 without the lazy update, allowing a borrower to draw more on a delinquent position]
1. Assert `amount > 0`
2. Assert `vault_state == 0` — blocked in states 1 and 2
3. Assert oracle is fresh
4. Accrue interest to current timestamp
5. Compute `lp_value = vault.lp_amount × oracle.price_per_lp / 1_000_000`
6. Assert `musd_borrowed + accrued_interest + amount ≤ floor(lp_value × ltv_bps_[vault.lp_pool_id] / 10_000)`
7. Increase `musd_borrowed` by `amount`
8. Call PSM `issue_musd(caller, amount)` via inner transaction
9. `flat_fee=true, fee=3000` — covers: vault execution (1000) + inner AppCall to PSM.issue_musd (1000) + PSM's inner AssetTransfer to borrower (1000)

**Total debt check includes accrued interest.** Checking only principal would allow a borrower to draw to the LTV limit, let interest accrue, then draw again — exceeding the LTV on their actual total obligation.

---

## Health Factor

The health factor measures the ratio of collateral value to total debt:

```
total_debt       = musd_borrowed + accrued_interest
lp_value         = lp_amount × oracle.price_per_lp / 1_000_000   [WideRatio required]
health_factor    = floor(lp_value × liq_threshold_bps / 10_000) / total_debt
```

| Value | State |
|---|---|
| > 1.0 | Healthy |
| = 1.0 | Liquidation boundary |
| < 1.0 | Health liquidation eligible (admin may act) |

**Note:** the quarterly payment requirement is a separate trigger from the health factor. A borrower can have an excellent health factor (LP value well above LTV) but still be eligible for micro-liquidation if they have not paid interest in 4 months. These are independent mechanisms.

---

## Payment Overdue Transition

`vault_state` is never set to 1 automatically. The oracle bot has no vault permissions and cannot transition state. Two mechanisms exist:

**Lazy discovery:** the following methods check `current_timestamp >= last_payment_timestamp + 90 days` at the very start and set `vault_state = 1` if true, before any other logic executes: `pay_interest()`, `repay_principal()`, `borrow_more()`, `add_collateral()`. Admin-only and vault-creation methods do not perform this check. The check never blocks the operation — it only updates state to reflect reality before proceeding.

**Admin transition:** `mark_payment_overdue(borrower, pool_id)` — admin wallet only
1. Assert vault exists and `vault_state == 0`
2. Assert `current_timestamp >= last_payment_timestamp + 90 days`
3. Set `vault_state = 1`
4. `flat_fee=true, fee=1000`

The admin uses this to explicitly mark delinquent vaults in the monitoring dashboard, making their state visible on-chain before triggering micro-liquidation.

---

## No Partial Collateral Withdrawal

LP collateral cannot be partially withdrawn while any debt is outstanding. The vault returns all collateral in one action only when `musd_borrowed == 0` and all accrued interest is cleared.

This eliminates health factor manipulation where a borrower partially withdraws collateral to harvest equity from an appreciating LP position while keeping debt outstanding.

---

## Vault Global State (Protocol-Level)

| Key | Type | Description |
|---|---|---|
| `psm_app_id` | uint64 | PSM contract app ID |
| `lp_oracle_app_id` | uint64 | LP oracle app ID |
| `musd_asa_id` | uint64 | mUSD ASA ID |
| `usdc_asa_id` | uint64 | USDC ASA ID |
| `accumulated_fees` | uint64 | mUSD accumulated from interest payments; swept via `collect_fees()` |
| `admin` | account | Hot admin key (mutable via 2-step rotation); initialized to deployer |
| `guardian` | account | Cold guardian key (pause/veto/recovery) |
| `pending_admin` | account | Proposed admin awaiting `accept_admin()` (zero when none) |
| `pending_guardian` | account | Proposed guardian awaiting `accept_guardian()` (zero when none) |
| `paused` | uint64 | 1 = new borrowing halted; 0 = active |
| `pending_lp_oracle` | uint64 | Queued LP-oracle app id awaiting timelock confirmation (0 when none) |
| `pending_lp_oracle_eta` | uint64 | Unix timestamp after which the queued oracle change may be confirmed |
| Rates per vault type | uint64 per pool | `rate_bps_[pool_id]` — interest rate per supported LP pool |
| LTV per vault type | uint64 per pool | `ltv_bps_[pool_id]` |
| LTV threshold per vault type | uint64 per pool | `liq_threshold_bps_[pool_id]` |
| LP ASA per vault type | uint64 per pool | `lp_asa_id_[pool_id]` — LP token ASA ID for each supported pool |

### Two-Role Admin Model

All admin-gated methods assert `Txn.sender == admin` (the stored hot key, not the immutable creator). The **guardian** (cold key) holds containment powers only:
- `pause()` (either role) / `unpause()` (guardian only) — gates new borrowing
- `cancel_pending_lp_oracle()` (admin or guardian) — veto a queued oracle repoint
- `propose_admin()` (admin or guardian) — the guardian path enables recovery of a lost/compromised hot key
- 2-step rotation: `propose_admin`/`accept_admin`, `propose_guardian`/`accept_guardian`

Seized LP, swept fees, and swept ALGO route to the **current** `admin` (so rotation redirects revenue correctly).

---

## Rate and Parameter Management Methods

All methods in this section require `Assert Txn.sender == Global.creator_address`.

**`set_rate(pool_id, rate_bps)`**
1. Assert `Txn.sender == Global.creator_address`
2. Assert `pool_id` is in supported pool whitelist
3. Assert `rate_bps ≤ 3000` — on-chain cap: 30% APR maximum; prevents a compromised admin key from setting rates that make all vaults instantly delinquent
4. Update `rate_bps_[pool_id]`; affects only vaults opened AFTER this call (existing vaults have rate locked at open time)

**`set_ltv(pool_id, ltv_bps)`**
1. Assert `Txn.sender == Global.creator_address`
2. Assert `pool_id` is in supported pool whitelist
3. Assert `ltv_bps < liq_threshold_bps_[pool_id]` — LTV must stay below liquidation threshold; if equal or above, borrowers at max LTV would be immediately health-liquidatable
4. Assert `ltv_bps > 0`
5. Update `ltv_bps_[pool_id]`; affects only new borrows and `borrow_more()` calls; existing vault positions are not forcibly reduced

**`set_liq_threshold(pool_id, threshold_bps)`**
1. Assert `Txn.sender == Global.creator_address`
2. Assert `pool_id` is in supported pool whitelist
3. Assert `threshold_bps > ltv_bps_[pool_id]` — threshold must exceed LTV; violation means borrowers at max LTV have HF < 1.0 upon origination, making them instantly liquidatable
4. Assert `threshold_bps ≤ 9000` — cap at 90%; setting above this makes the liquidation trigger fire before meaningful overcollateralization exists
5. Update `liq_threshold_bps_[pool_id]`

**`set_lp_asa_id(pool_id, lp_asa_id)`**
1. Assert `Txn.sender == Global.creator_address`
2. Assert `pool_id` is in supported pool whitelist
3. Update `lp_asa_id_[pool_id]` — the LP token ASA ID used in `open_vault()` and `add_collateral()` type checks

**LP-oracle repointing (timelocked — replaces the old instant `set_lp_oracle`)**

Repointing the oracle is the single most dangerous power (a malicious oracle posts arbitrary prices → over-borrow). It is therefore a **48h timelock with a guardian veto** (P19-03 / P19-10):

- **`propose_lp_oracle(new_oracle_app_id)`** — admin only; asserts `!= 0`; stores `pending_lp_oracle` + `pending_lp_oracle_eta = now + 48h`.
- **`confirm_lp_oracle()`** — admin only; asserts a pending change exists and `now >= eta`; applies it and clears the pending slots.
- **`cancel_pending_lp_oracle()`** — admin **or guardian**; clears the pending change. This is the guardian's veto if a compromised hot key queues a malicious oracle.

Admin procedure before proposing: audit the new oracle contract; verify its deviation/anchor guards and authorized updater; run it in parallel before the 48h elapses.

**`advance_accrual(borrower, pool_id)`** — admin only
1. Assert `Txn.sender == admin`; vault exists; `vault_state != 2`
2. Run `_accrue_interest` (1-year cap per call) and write back
3. Purpose: catch up interest on a multi-year-abandoned vault (a delinquent borrower won't trigger accrual themselves); call repeatedly to advance in annual increments before liquidating (P19-13)

**`collect_algo(amount)`** — admin wallet only
1. Assert `Txn.sender == Global.creator_address`
2. Assert `amount > 0`
3. Inner transaction: Payment of `amount` ALGO to admin wallet

**Note:** the contract does **not** compute the excess on-chain — the admin supplies `amount`, computed off-chain as `contract_algo_balance − (open_vault_count × 46,500) − buffer`. The AVM is the safety net: any `amount` that would drop the vault's balance below its own minimum-balance requirement (which includes all open vault box MBR) causes the inner Payment to fail and the transaction to revert. A miscalculated sweep therefore fails closed rather than stranding MBR. An on-chain excess computation (requiring an `open_vault_count` global counter) is deferred — see P19-08.

---

## Known Approximations

**Oracle freshness window (TBD).** Unlike v1 which used a 10-minute staleness window, the LP oracle window is TBD — LP prices are less volatile intrablock than single-asset prices, so the window may be longer (e.g., 30 minutes). A stale oracle blocks new borrows but does not block collateral deposits or interest payments.

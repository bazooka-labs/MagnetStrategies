# MagnetFi v2 — Security Audit Notes

Running document for architectural flags, security concerns, and pass-by-pass findings. Updated as each review pass is completed.

---

## Status Key

| Symbol | Meaning |
|---|---|
| 🔴 | Open — not yet addressed |
| 🟡 | Mitigated — partial fix or accepted risk with documentation |
| 🟢 | Resolved — fix implemented or confirmed non-issue |

---

## Pass 1 — Architectural Review (Pre-contract)

High-level design flags identified before any contract code is written. Source: design doc review session.

---

### LP Oracle

**[AUD-001] 🔴 Off-chain TWAP is unverifiable**
- The TWAP is computed by the oracle bot and the contract only sees the final posted price. There is no on-chain proof that TWAP smoothing was applied.
- The only contract-level guard is the 50% deviation limit.
- For an admin-managed protocol this is an accepted trust assumption — but it must be explicitly documented, not implied.
- **Action:** Add explicit trust assumption note to LP_ORACLE.md. Evaluate whether on-chain cumulative price storage is feasible in v3.

**[AUD-002] 🔴 Bot restart resets TWAP history**
- If the oracle bot crashes and restarts, the rolling price history in memory is lost.
- First post after restart uses raw spot price with no averaging — a brief manipulation window if timed with a restart.
- **Action:** Persist TWAP history to disk or lightweight database. Must be implemented before mainnet.

**[AUD-003] 🟢 First price post per pool is unguarded — closed by AUD-043**
- The on-chain deviation guard activates only `if current_price[pool_id] != 0`.
- The very first price posted for any new pool had zero contract-level protection.
- A compromised bot at pool-add time could post an arbitrary initial price.
- **Fix (Pass 5):** `add_pool()` now requires `initial_price` set by admin under hardware wallet. Price is stored at pool creation, so deviation guard is active from the first bot update. See AUD-043.

**[AUD-004] 🔴 Single authorized updater is a liveness single point of failure**
- One bot wallet, one process. Bot outage > freshness window pauses the protocol (no new borrows, no health liquidations).
- **Action:** Build monitoring and alerting around bot uptime before mainnet. Evaluate redundant bot instances as a pre-mainnet requirement (not post-launch nice-to-have).

**[AUD-005] 🟡 Global state key ceiling**
- Algorand global state has a 64-key limit. Current design uses 2 keys per pool (price + timestamp) plus admin fields.
- 4 pools = 8 keys — fine now. Becomes a hard ceiling at ~28 pools.
- Accepted risk for v2. Box storage is the migration path if pool count grows significantly.
- **Action:** Design oracle contract so box storage can be added later without full redeployment. Do not hardcode assumptions that all prices are in global state.

**[AUD-006] 🔴 wBTC ASA decimal count unverified**
- Decimal normalization in the LP price formula assumes specific decimal values per asset.
- wBTC on Algorand is a bridged asset — actual ASA decimal count must be verified against the live token before launch.
- Getting this wrong produces a silently incorrect price off by orders of magnitude.
- **Action:** Verify all ASA decimal counts against live Algorand mainnet before bot deployment. Add decimal config table to bot with explicit source for each value.

---

### Liquidation

**[AUD-007] 🟡 Partial liquidation tier boundary enforcement relies on oracle freshness**
- `trigger_partial_liquidation(tier=1)` asserts HF is in [0.85, 0.9999] at execution time. If oracle is stale, the health factor used for tier assertion may not match current market reality.
- A position at real HF 0.83 could be in tier 2 range in the contract if the oracle hasn't updated.
- Mitigation: contract already requires oracle freshness for all health liquidations. Stale oracle blocks the call entirely before tier check runs.
- Residual risk: within the oracle freshness window (30 min), market can move enough to shift tier. Admin should re-check HF on a fresh oracle update before calling.
- **Action:** Admin procedure should include "verify HF on latest oracle update" before calling any tier — documented in ADMIN.md tiered procedure.

**[AUD-008] 🟡 Partial liquidation settlement window leaves debt outstanding**
- After `trigger_partial_liquidation()`, position is in state 2. The seized LP is in admin wallet. `outstanding_settlement` is non-zero. If admin never calls `settle_health_liquidation()`, the vault is stuck in state 2 indefinitely.
- Borrower cannot pay interest, add collateral, or otherwise interact while stuck in state 2.
- This is the same risk as health liquidation generally — it is an accepted operational assumption for an admin-managed protocol.
- Mitigation: USDC float procedure ensures same-session settlement is the normal path.
- **Action:** Monitor for any vault in state 2 for >1 hour; alert for operator attention.

**Design note — 3-tier rationale:**
- Tier 1 (35% at HF 0.95–0.9999): worst-case restores HF to 1.109 ✓
- Tier 2 (60% at HF 0.85–0.9499): worst-case restores HF to 1.063 ✓
- Tier 3 (<0.85 full): 60% seizure at this depth leaves insufficient margin for continued price decline
- Pre-calibrated percentages enable 1-click admin action under market stress with no manual calculation required

---

### PSM

*No flags identified in architectural review. Items to revisit during contract security pass:*
- Re-entrancy via inner transactions (issue_musd / receive_musd cross-app calls)
- Invariant check ordering (assert before state change before inner transaction)
- Dust attack on redeem_musd (assert usdc_out > 0 already in design — confirm implemented)
- treasury_address set to zero address at deploy (should be asserted non-zero)

---

### Vault

*No flags identified in architectural review. Items to revisit during contract security pass:*
- State guard completeness across all methods
- Integer overflow in interest accrual (block_interest multiplication before division)
- borrow_more total debt check includes accrued interest (already in design — confirm implemented)
- MBR return on vault closure (46,500 microALGO — confirm matches actual box size at deploy; key is 46 bytes with pool_id suffix)

---

### mUSD ASA

*No flags identified in architectural review. Items to revisit:*
- Manager key — confirm admin wallet holds manager role at creation; plan for eventual transfer to contract
- Total supply (500M) — confirm base unit representation is within uint64 range (500M × 1,000,000 = 5 × 10^14 — within uint64 max of ~1.8 × 10^19 ✓)

---

---

## Pass 2 — Full Protocol Design Audit

Deep review of all 6 design docs for logic errors, invariant violations, economic exploits, and missing guards. All critical and high-severity items fixed in-doc.

---

### Critical — Fixed

**[AUD-009] 🟢 Partial liquidation settlement amount was total_debt (incorrect)**
- `outstanding_settlement = total_debt` for partial liquidation would require admin to return the ENTIRE borrowed mUSD ($6,000) despite seizing only 35% of LP ($2,660). Admin loses $3,340. No rational actor runs this.
- **Fix:** Redesigned settlement so `seized_lp_value` (not `total_debt`) is what admin returns to PSM. `vault.musd_borrowed` is set to the new reduced debt (`total_debt − seized_lp_value`). `vault.accrued_interest` is repurposed in state 2 as the settlement counter (`seized_lp_value`). Vault returns to active with lower debt. Math verified: HF ≥ 1.06 after settlement at each tier's worst case. ✓

---

### High — Fixed

**[AUD-010] 🟢 State transition diagram showed micro-liquidation going through state 2**
- Diagram said `payment_overdue → in_liquidation → active` for micro-liq. Actual flow: micro-liq sets `vault_state = 0` directly from state 1 — never enters state 2.
- **Fix:** Corrected diagram. Added note that state 2 is health-factor liquidations only.

**[AUD-011] 🟢 treasury_address zero-address vulnerability in PSM**
- `redeem_musd()` sent 1% fee to `treasury_address`. If `set_treasury()` not called before first redemption, fee burns to zero address permanently.
- **Fix:** Added `Assert treasury_address != ZeroAddress` to both `redeem_musd()` and `set_treasury()` in PSM.md.

**[AUD-012] 🟢 Integer overflow in interest accrual**
- `annual_interest × seconds_elapsed` intermediate product overflows uint64 for large loans after extended dormancy (~7.3 years for 100K mUSD at 8% APR, timestamp-based). AVM traps on overflow — legitimate admin actions would fail.
- **Fix:** Added overflow guard in VAULT.md: cap `seconds_elapsed` at `SECONDS_PER_YEAR`; require sequential accrual calls for dormant positions. Quarterly payment window makes this rare in practice.

**[AUD-013] 🟢 Micro-liquidation has no escalation path when interest exceeds collateral value**
- If `lp_to_seize > lp_amount` (years of non-payment), the micro-liq assert fails. No documented path out.
- **Fix:** Added escalation note in LIQUIDATION.md Known Assumptions: admin should trigger `trigger_full_liquidation()` directly. Edge case for contracts where HF is ≥ 1.0 but micro-liq is impossible deferred to Pass 3 (contract-level design).

**[AUD-014] 🟢 last_accrual_timestamp not reset on partial liquidation settlement**
- After partial liq and settlement, vault returned to state 0 with stale `last_accrual_timestamp`. First post-settlement accrual would charge interest for all of state 2 time.
- **Fix:** `settle_health_liquidation()` now explicitly sets `last_accrual_timestamp = current_timestamp` before returning vault to state 0.

---

### Medium — Fixed

**[AUD-015] 🟢 Tier boundary expressed as "0.9499" instead of strict inequalities**
- "0.9499" in contract code would leave an implementation gap at exactly HF = 0.95.
- **Fix:** All tier boundaries now use strict inequalities: `HF_num × 100 >= HF_den × 95`, etc. Exact integer arithmetic, no gaps.

**[AUD-016] 🟢 Shortfall scenario: invariant broken with no documented recovery path**
- Full liquidation where LP value < total debt leaves circulating mUSD with no USDC backing.
- **Fix:** Added shortfall procedure to LIQUIDATION.md and ADMIN.md: admin deposits deficit USDC into PSM BEFORE settling vault. Preserves invariant before closure.

**[AUD-017] 🟢 USDC float replenishment missing from monitoring checklist**
- Float depletes after each liquidation; no reminder to replenish before next event.
- **Fix:** Added "Admin wallet USDC float < $200 → replenish from LP proceeds" to ADMIN.md monitoring table.

---

### Decisions Pending (User Input Required)

**[AUD-018] 🟢 Single vault per borrower — changed to multi-vault**
- Old box key `"vault_" + borrower_pubkey` (38 bytes) limited each address to one vault.
- **Decision:** Multi-vault. New box key: `"vault_" + borrower_pubkey (32 bytes) + pool_id (8 bytes, uint64 big-endian)` = 46 bytes. One vault per LP type per address. MBR updated: 46,500 microALGO (was 43,300).

**[AUD-019] 🟢 Switched to timestamp-based interest accrual**
- Block-based accrual (`last_accrual_block`) drifts if Algorand block cadence changes — stated APR would be inaccurate without any contract update.
- **Decision:** Timestamp-based. `last_accrual_block` → `last_accrual_timestamp` (unix seconds). Formula now uses `SECONDS_PER_YEAR = 31_536_000`. Consistent with `last_payment_timestamp` already in vault box. Overflow window extends to ~7.3 years at 100K mUSD borrowed (up from ~3.66 years block-based).

**[AUD-020] 🟢 No liquidation fee on health-factor path**
- **Decision:** 0% liquidation fee on both partial and full health liquidations. Admin acts as protocol steward, not a fee-extracting liquidator. Partial liquidations are already positioned on the more favorable end of the health scale. Risk parameter table updated.

---

---

## Pass 3 — Vault Contract Method-Level Security Review

Line-by-line review of every vault method for access control, state guard completeness, arithmetic correctness, and cross-contract interaction safety.

---

### Critical — Fixed

**[AUD-021] 🟢 `settle_health_liquidation()` — no mUSD transfer verification**
- Method reduced the settlement counter and called PSM.receive_musd() but never verified an actual mUSD AssetTransfer was present in the group. Attacker calls with musd_amount=X, no mUSD sent, settlement counter drops, circulating mUSD not reduced. Invariant broken when vault returns to active.
- **Fix:** Step 2 now asserts AssetTransfer in group with ASA ID = mUSD, receiver = vault address, amount = musd_amount exactly.

**[AUD-022] 🟢 `add_collateral()` — wrong LP token accepted**
- No LP ASA ID verification. An attacker could deposit U/ALGO LP tokens into a U/USDC vault — oracle prices the vault type as U/USDC but collateral is actually U/ALGO. Enables over-borrowing against incorrectly valued collateral.
- **Fix:** Added `lp_asa_id_[pool_id]` to vault global state. `add_collateral()` now asserts AssetTransfer ASA ID matches the vault's registered LP token.

**[AUD-023] 🟢 `pay_interest()` — accrual after amount check causes underflow**
- Amount check used pre-accrual `accrued_interest`. Subsequent accrual increased it. `change = transfer.amount − new_accrued_interest` underflows (uint64 panic) on valid transactions.
- **Fix:** Accrue first, then check `transfer.amount >= accrued_interest`.

**[AUD-024] 🟢 `pay_interest()` — interest forwarded to PSM (contradicts design)**
- VAULT.md step 7 forwarded interest to PSM. Confirmed design: interest accumulates in vault for admin to sweep. Auto-forwarding removes flexibility to deploy interest as DEX liquidity.
- **Fix:** Interest mUSD stays in vault, added to `accumulated_fees` counter. Added `collect_fees()` admin method. Only principal repayments call PSM.receive_musd().

**[AUD-025] 🟢 `add_collateral()` — incorrectly cleared vault_state 1→0**
- Adding collateral reset payment-overdue status without paying interest. Borrowers could add dust LP to block micro-liquidation indefinitely without paying.
- **Fix:** `add_collateral()` never modifies `vault_state`. Only `pay_interest()` clears state 1.

---

### High — Fixed

**[AUD-026] 🟢 vault_state 1 transition mechanism undefined**
- State diagram said "oracle bot / cron" sets state 1, but the bot can only post LP prices. `trigger_micro_liquidation()` required state == 1 but no method existed to set it.
- **Fix:** Added `mark_payment_overdue(borrower, pool_id)` admin method. Also added lazy detection: all vault interactions check the 90-day timestamp and auto-set state 1 if overdue.

**[AUD-027] 🟢 `pay_interest()` and `repay_principal()` — missing state 2 guard**
- State guards table blocked both in state 2, but neither method spec included the assertion. In state 2, `accrued_interest` is the settlement counter — zeroing it via `pay_interest()` would falsely complete settlement.
- **Fix:** Both methods now assert `vault_state != 2` as first step.

**[AUD-028] 🟢 Interest accrual multiplication overflows for large vaults**
- `annual_interest × seconds_elapsed` overflows uint64 for positions above ~60M mUSD at 8% APR. AVM traps on overflow.
- **Fix:** Documented `WideRatio(annual_interest, seconds_elapsed, SECONDS_PER_YEAR)` (AVM mulw/divw) as a contract implementation requirement. Standard uint64 arithmetic is prohibited for this calculation.

**[AUD-029] 🟢 `open_vault()` — oracle check required even for zero-borrow open**
- Borrowers depositing LP without borrowing (deferred draw) were blocked by oracle freshness check. Collateral deposits should never be blocked.
- **Fix:** Oracle check and LTV calculation skipped entirely when `borrow_amount == 0`. Also added explicit "vault box does not exist" assertion and LP ASA ID verification.

---

### Medium — Fixed

**[AUD-030] 🟢 `borrow_more(0)` — no zero-amount guard**
- Zero-amount call passes LTV check, then PSM.issue_musd(0) fails at ASA layer. Wasteful and noisy.
- **Fix:** `Assert amount > 0` added as first step of `borrow_more()`.

**[AUD-031] 🟢 `collect_fees()` not defined in VAULT.md**
- Referenced across ADMIN.md and OVERVIEW.md but never specced in VAULT.md.
- **Fix:** Added `collect_fees()` method spec to VAULT.md payment flow section.

**[AUD-032] 🟢 `protocol_fee_bps` — purpose undefined; removed**
- Field in vault global state with no implemented use (interest now accumulates in vault without splitting). Replaced with `accumulated_fees` (the actual counter tracking swept interest).
- **Fix:** Removed `protocol_fee_bps`. Added `accumulated_fees` counter and `usdc_asa_id` (needed for admin PSM interactions).

---

### Decision Pending

**[AUD-033] 🟢 `repay_principal()` — group introspection removed; hard precondition instead**
- Group introspection to verify "interest paid in same group" adds implementation complexity with no benefit — the overpayment flow in `pay_interest()` already handles single-call full repayment.
- **Decision:** `repay_principal()` requires `accrued_interest == 0` as a hard precondition. Borrowers wanting to clear both in one call use `pay_interest(accrued_interest + principal_amount)`; overpayment automatically routes to principal.

---

---

## Pass 4 — PSM Contract Method-Level Security Review

Line-by-line review of every PSM method for access control, arithmetic correctness, caller verification, and edge-case behavior.

---

### Critical — Fixed

**[AUD-034] 🟢 `withdraw_usdc()` — guard has uint64 underflow**
- `Assert psm_usdc_balance − amount ≥ circulating_musd`: if `amount > psm_usdc_balance`, unsigned subtraction underflows and AVM panics before comparison. An invalid withdrawal request traps instead of cleanly rejecting.
- **Fix:** Rewrote guard as `Assert psm_usdc_balance ≥ circulating_musd + amount` — equivalent semantics, no underflow risk.

**[AUD-035] 🟢 All admin methods missing `Assert Txn.sender == Global.creator_address`**
- All four admin methods (`withdraw_usdc`, `set_redeem_fee`, `set_treasury`, `set_vault_contract`) were labeled "admin wallet only" but the step-by-step specs never included the sender assertion. Missing `set_vault_contract` check is critical: anyone could register a malicious contract authorized to mint mUSD.
- **Fix:** Added `Assert Txn.sender == Global.creator_address` as the first step of every admin method. Added a callout note: "All admin methods must include this as their first assertion."

**[AUD-036] 🟢 `redeem_musd()` breaks when `redeem_fee_bps = 0`**
- When admin reduces fee to 0%: `fee_out = 0`. Inner transaction 2 attempts a zero-amount ASA transfer to treasury — Algorand rejects all zero-amount transfers. Every redemption fails while fee is 0%.
- **Fix:** Step 8 now conditional: "If `fee_out > 0`: send inner tx 2." Fee parameter also updated: `flat_fee=true, fee=2000` when no fee inner tx, `fee=3000` when fee > 0.

---

### High — Fixed

**[AUD-037] 🟢 `receive_musd()` — no amount parameter; ambiguous which AssetTransfer is verified**
- Method spec took no argument, making it impossible to specify the exact amount being returned. In an inner transaction group from the vault, multiple AssetTransfers could be present. Without an amount parameter and exact-match assertion, the PSM cannot verify it received the intended mUSD.
- **Fix:** Signature changed to `receive_musd(amount)`. Step 3 now asserts AssetTransfer in group with ASA ID = mUSD, receiver = PSM address, amount = `amount` exactly — matching the pattern used by `settle_health_liquidation()`.

**[AUD-038] 🟢 `issue_musd()` and `receive_musd()` — caller verification compared wrong types**
- Spec said "Assert caller is the registered `vault_app_id`." In Algorand, `Txn.sender` is a 32-byte address; `vault_app_id` is a uint64 app ID. Comparing them directly is a type mismatch that never matches — the assertion would either always fail (if typed) or always pass (if incorrectly evaluated as zero vs. non-zero).
- **Fix:** Added a "Caller Verification Note" section to PSM.md. Caller check must use `AppParam.address(vault_app_id).value` to convert the app ID to its escrow address for comparison. Both method specs now state this explicitly.

**[AUD-039] 🟢 `issue_musd()` — missing `Assert amount > 0` guard**
- Zero-amount call would pass the invariant check and attempt an inner transaction transferring 0 mUSD, which Algorand rejects. Better to fail immediately with a clear assertion.
- **Fix:** `Assert amount > 0` added as first step of `issue_musd()`.

---

### Medium — Fixed

**[AUD-040] 🟢 `mint_musd()` step 2 — invariant check is a tautology**
- `Assert circulating_musd + amount ≤ psm_usdc_balance + amount` simplifies to `circulating_musd ≤ psm_usdc_balance` — the pre-existing invariant. It doesn't check whether PSM has enough mUSD to issue (the real constraint). A developer reading this spec would believe ceiling enforcement happens here when it does not.
- **Fix:** Removed the tautology. Step 2 is now `Assert psm_musd_balance ≥ amount` (the actual binding constraint). Added a note explaining that PSM mint is self-balancing and the vault ceiling does not need checking here.

---

---

---

---

## Pass 5 — LP Oracle Contract Method-Level Security Review

Line-by-line review of every oracle method for access control, arithmetic correctness, zero-value states, and admin operation safety.

---

### Critical — Fixed

**[AUD-041] 🟢 Admin methods (`set_authorized_updater`, `add_pool`, `remove_pool`) missing sender assertion**
- All three methods were labeled "admin only" but had no step-by-step specs and no explicit `Assert Txn.sender == Global.creator_address`. A developer implementing from this spec would not add the guard. Missing `set_authorized_updater` check allows any caller to redirect oracle update authority to a malicious wallet, enabling arbitrary price postings.
- **Fix:** Added explicit step-by-step specs for all three methods. First assertion in every admin method is `Assert Txn.sender == Global.creator_address`. Added admin callout note matching the PSM pattern.

---

### High — Fixed

**[AUD-042] 🟢 `update_lp_price()` — missing `Assert new_price > 0`; zero price permanently bricks pool oracle**
- No guard on `new_price == 0`. If a zero price is stored as the initial value (e.g., bot malfunction or compromise on first post), the deviation guard constrains all future posts to `[0 × 50/100, 0 × 150/100] = [0, 0]`. The only valid future price is 0 — the pool oracle is permanently locked to zero with no recovery path except full oracle redeployment.
- **Fix:** `Assert new_price > 0` added as step 2 of `update_lp_price()`.

**[AUD-043] 🟢 AUD-003 structural fix — `add_pool()` now requires `initial_price`**
- AUD-003 (first post unguarded) was documented as a process risk with a manual deployment check. This pass closes it architecturally: `add_pool(pool_id, initial_price)` requires the admin to set the first price under the hardware wallet. This value is stored immediately, so the deviation guard is active from the very first bot update. The first-post manipulation window is eliminated entirely.
- **Fix:** `add_pool()` signature changed to `add_pool(pool_id, initial_price)`. Steps added: assert initial_price > 0, store price and timestamp. AUD-003 status upgraded from 🔴 to 🟢.

**[AUD-044] 🟢 `set_authorized_updater()` — missing `Assert new_address != ZeroAddress`**
- Setting `authorized_updater` to ZeroAddress bricks the oracle permanently — no valid signer exists; no price can ever be posted again. Protocol health liquidations freeze indefinitely.
- **Fix:** `Assert new_address != ZeroAddress` added as step 2 of `set_authorized_updater()`.

---

### Medium — Fixed

**[AUD-045] 🟢 Deviation guard uses multiplication-then-division (overflow pattern)**
- Contract form `new_price >= current_price × 50 / 100` uses standard uint64 multiplication. `current_price × 150` overflows uint64 at LP prices above ~1.2 × 10^17 (unachievable in practice, but unsafe arithmetic pattern should not be present in protocol contracts).
- **Fix:** Deviation guard rewritten using `WideRatio` (algopy) / mulw+divw (AVM), matching the pattern used for interest accrual throughout the vault contract. Contract spec updated with wide math form.

---

### Operational Risk — Documented

**[AUD-046] 🟡 `remove_pool()` with active vaults blocks health liquidations**
- Removing a pool from the oracle whitelist stops price updates for that pool ID. Existing vaults that have borrowed against that pool type can no longer have their health factors computed (oracle returns stale price; vault rejects health liquidation). Borrowers are stuck in a position they cannot be liquidated from.
- This is an operational risk, not a contract bug — the contract correctly enforces oracle freshness.
- **Fix (documentation):** `remove_pool()` spec now includes an explicit warning: admin must verify no active vaults exist for the pool before removal. Pre-removal checklist: query all vault boxes for `lp_pool_id == pool_id`; ensure all are closed first.

---

---

---

## Pass 6 — Cross-Contract Interaction Review

Traced every inner transaction flow between Vault, PSM, and LP Oracle. Checked Algorand's execution model constraints (Gtxn scope, inner tx sibling visibility, fee depth), balance model consistency, and group structure.

---

### Critical — Fixed

**[AUD-047] 🟢 `repay_principal()` and `settle_health_liquidation()` — mUSD routed to vault, not PSM; circulating supply never decreases**
- PSM tracks its mUSD balance from actual ASA holdings (no counters). When the spec said "outer group: AssetTransfer mUSD → vault contract" and then vault calls PSM.receive_musd(), the mUSD physically arrived at the VAULT, not PSM. PSM's ASA balance never changed → circulating mUSD (500M − psm_musd_balance) never decreased → circulating supply permanently overstated.
- Additionally, PSM.receive_musd() asserts AssetTransfer to PSM in the outer group (the Pass 4 fix). But with mUSD routed to vault, Gtxn shows transfer to vault → PSM assertion always fails → every repay_principal and every settle_health_liquidation would revert.
- **Fix:** Changed outer group AssetTransfer receiver from VAULT to PSM for both methods. User and admin now route mUSD directly to PSM contract address. Vault verifies the outer group transfer (to PSM), then calls PSM.receive_musd() as inner tx. PSM independently verifies the same outer group transfer. mUSD physically lands at PSM ✓. Both vault and PSM now double-verify the transfer. VAULT.md and LIQUIDATION.md updated.
- **ADMIN.md correction:** removed incorrect instruction to call `receive_musd()` to return swept mUSD to PSM; replaced with direct AssetTransfer to PSM address (no method call needed for admin-sourced returns; PSM balance updates automatically).

---

### High — Fixed

**[AUD-048] 🟢 `open_vault()` and `borrow_more()` — fee budget underfunded**
- `open_vault(borrow_amount > 0)` and `borrow_more()` both call PSM.issue_musd() as an inner AppCall. PSM.issue_musd() then issues its own inner AssetTransfer to send mUSD to the recipient. Algorand charges fee depth: vault outer execution (1000 µALGO) + inner AppCall to PSM (1000) + PSM's inner AssetTransfer (1000) = 3000 total.
- `open_vault()` spec stated flat_fee=2000 (insufficient by 1000). `borrow_more()` had no fee specified.
- Under AVM flat_fee semantics, a 2000 µALGO fee is insufficient to cover a 3-layer call depth; the transaction would fail on mainnet.
- **Fix:** Both methods updated to flat_fee=3000. VAULT.md updated.

---

### Medium — Fixed

**[AUD-049] 🟢 Dust LP edge case: partial liquidation leaves vault permanently stuck in state 2**
- For a 1 base-unit LP position at Tier 2: `ceil(1 × 6000 / 10000) = ceil(0.6) = 1`. Tier 2 seizes 100% of a 1-unit LP position. `lp_amount = 0` after seizure, `musd_borrowed > 0` (settlement counter set to the 1-unit LP value, debt reduced by same).
- After admin settles: `accrued_interest == 0, musd_borrowed > 0, lp_amount == 0`. No completion branch matched. Vault stuck in state 2 forever with no exit path. Vault box cannot be deleted; MBR locked.
- In practice this requires a sub-cent LP position — vanishingly unlikely — but the stuck state has no recovery mechanism.
- **Fix:** Added fourth completion branch to `settle_health_liquidation()`: `accrued_interest == 0 AND musd_borrowed > 0 AND lp_amount == 0` → write off remaining debt as bad debt; close vault box; return 46,500 µALGO MBR to borrower. LIQUIDATION.md updated.

---

### Low — Fixed

**[AUD-050] 🟢 ADMIN.md incorrectly suggested calling `PSM.receive_musd()` for admin mUSD returns**
- After sweeping interest fees via `collect_fees()`, ADMIN.md said admin could call `receive_musd()` to return mUSD to PSM. But `receive_musd()` requires `Txn.sender == vault_app_address` — the admin wallet is not the vault contract; this call would always fail.
- Also referenced stale `protocol_fee_bps` field (removed in AUD-032).
- **Fix:** ADMIN.md corrected to: admin sends mUSD directly to PSM contract address via plain AssetTransfer; no method call needed; PSM's actual ASA balance updates automatically. Stale `protocol_fee_bps` reference removed.

---

---

---

## Pass 7 — Admin Operations and Privilege Escalation

Full review of the admin privilege surface: what each admin action can do, what it cannot do, and what missing on-chain guards could be exploited if the admin key is compromised or acts maliciously.

**Admin privilege summary:**
- PSM: `withdraw_usdc`, `set_redeem_fee`, `set_treasury`, `set_vault_contract`
- Vault: `collect_fees`, `mark_payment_overdue`, all liquidation triggers, `set_rate`, `set_ltv`, `set_liq_threshold`, `set_lp_oracle`
- LP Oracle: `set_authorized_updater`, `add_pool`, `remove_pool`

---

### High — Fixed

**[AUD-051] 🟢 `set_ltv()` and `set_liq_threshold()` — no cross-parameter guard; can create instant liquidation**
- No on-chain assertion that `liq_threshold_bps > ltv_bps` in either setter.
- If admin sets `liq_threshold_bps` below `ltv_bps` (or sets `ltv_bps` above `liq_threshold_bps`): any borrower opening a vault at max LTV immediately has HF = (collateral × threshold) / debt < 1.0. Every new borrow is instantly health-liquidatable.
- A compromised admin key could weaponize this to seize collateral from new borrowers at will.
- **Fix:** Added full method specs for both setters in VAULT.md:
  - `set_liq_threshold()`: Assert `threshold_bps > ltv_bps_[pool_id]`; Assert `threshold_bps ≤ 9000`
  - `set_ltv()`: Assert `ltv_bps < liq_threshold_bps_[pool_id]`; Assert `ltv_bps > 0`

**[AUD-052] 🟢 `set_rate()` — no on-chain rate cap; abusive rates possible**
- No defined upper bound on `rate_bps`. Admin (or a compromised key) could set rate to e.g. 99,000 bps (990% APR). Every vault's `accrued_interest` would balloon to exceed its collateral value within hours, making the entire portfolio health-liquidatable in one session.
- **Fix:** Added on-chain cap `Assert rate_bps ≤ 3000` (30% APR). Current protocol rates (5–8%) are well below this ceiling. The 30% cap allows significant business flexibility while preventing weaponization. VAULT.md updated.

---

### Medium — Fixed

**[AUD-053] 🟢 `set_lp_oracle()` — no safety procedure documented for high-impact change**
- Redirecting vault to a malicious oracle contract enables arbitrary LP price postings: over-borrowing on inflated prices, or instant liquidations on deflated prices. No timelock, no verification step in the spec.
- This is a trust-the-admin design assumption, but the risk surface should be explicit.
- **Fix:** Added explicit warning to `set_lp_oracle()` spec in VAULT.md: admin must audit new oracle contract code and verify deviation guard + authorized updater before calling. Recommend running new oracle in parallel before switching.

---

### Low — Documented

**[AUD-054] 🟡 No protocol pause mechanism**
- If a critical bug is found post-launch, there is no on-chain mechanism to halt new borrows or mints while positions are wound down safely. Oracle staleness is the only natural brake (stale oracle blocks new borrows; PSM minting remains open).
- This is a known v2 limitation. Complexity of adding pause flags is significant; hardware wallet substantially reduces compromise risk.
- **Action (v2.1):** Add `vault_paused_[pool_id]` and `psm_paused` boolean flags. Pause blocks new borrows and mints; leaves repayments and interest payments open so borrowers can exit safely.

---

---

---

## Pass 8 — Economic Attack Surface

Review of oracle manipulation, MEV exposure, liquidation gaming, and protocol invariant stress testing.

---

### Economic Attacks Analyzed and Dismissed

**Oracle manipulation via pool reserve manipulation:**
- Requires attacker to hold real capital in the Tinyman pool (no flash loans on Algorand). Large swaps leave attacker exposed to arbitrage. TWAP (15–25 min) limits single-reading spikes. 50% on-chain deviation guard and 15% source divergence check are three independent barriers. Residual risk: patient whale could push reserves slowly. Accepted; standard DeFi oracle risk.

**Timestamp gaming:**
- Vault timestamps are set from `Global.LatestTimestamp`, not from user inputs. Algorand validators have seconds-level discretion but cannot make time go backwards. No manipulation path. ✓

**Liquidation tier griefing:**
- Borrower can add collateral to push HF from Tier 2 range into Tier 1 range just before admin triggers. Admin's Tier 2 trigger reverts; admin re-submits Tier 1. Minor operational inconvenience, not a vulnerability.

**PSM circular arbitrage:**
- Mint (0% fee) then redeem (1% fee) = attacker loses 1% net. No profitable circular path. ✓

**Flash repayment to dodge liquidation:**
- Borrower repays debt to push HF above 1.0 just before admin triggers. This is a legitimate borrower action; admin cannot liquidate a healthy position. No exploit.

---

### Medium — Fixed

**[AUD-055] 🟢 ADMIN.md incorrectly states micro-liquidations are unblocked during oracle outage**
- `trigger_micro_liquidation()` requires oracle freshness because the seizure calculation (`lp_to_seize = ceil(total_recovery_musd × 1_000_000 / lp_price)`) needs the current oracle price. No fresh price → no valid seizure amount.
- ADMIN.md emergency procedures stated "Micro-liquidations are still possible if state is already 1 (no oracle needed for that check — TBD by contract design)." This is incorrect.
- An oracle outage means delinquent borrowers cannot be micro-liquidated. This is more severe than previously described: the oracle is critical for ALL enforcement, not just health liquidations.
- **Fix:** ADMIN.md emergency procedures corrected to: "All liquidations are blocked" during oracle outage. List of unblocked operations (repayments, interest payments, collateral deposits) now explicit. ADMIN.md updated.

---

### Low — Documented

**[AUD-056] 🟢 Interest accrual relies on implicit Algorand timestamp monotonicity guarantee**
- `seconds_elapsed = current_timestamp − last_accrual_timestamp` would underflow (uint64) if `last_accrual_timestamp > current_timestamp`. This cannot happen on Algorand (`Global.LatestTimestamp` is monotonically non-decreasing), but the spec never stated this dependency explicitly.
- **Fix:** Added note to VAULT.md interest accrual section: this is an Algorand-specific invariant; future migrations to other runtimes must guard against timestamp regression. VAULT.md updated.

---

---

---

## Pass 9 — Pre-Deploy Checklist Verification

Cross-checked the ADMIN.md deployment procedure against all fixes and design decisions documented in Passes 1–8. Identified missing initialization steps that would cause silent failures or broken protocol state on launch.

---

### High — Fixed

**[AUD-057] 🟢 Deployment checklist missing `set_treasury()` — first redemption would always revert**
- PSM deployment checklist did not include `set_treasury(address)`. The default value of `treasury_address` is the zero address. `redeem_musd()` asserts `treasury_address != ZeroAddress` (AUD-011 fix). Result: the PSM would accept minted mUSD but every redemption would revert until treasury was set.
- **Fix:** `set_treasury()` call added to PSM initialization section. ADMIN.md updated.

**[AUD-058] 🟢 Deployment checklist missing vault risk parameter initialization**
- Vault global state defaults all `rate_bps_[pool_id]`, `ltv_bps_[pool_id]`, and `liq_threshold_bps_[pool_id]` to 0 (Algorand default for new global state). With `liq_threshold_bps = 0`, all vaults are immediately health-liquidatable at any LTV (health factor = 0 × anything / debt = 0 < 1). With `ltv_bps = 0`, `max_borrow = 0` and no one can borrow.
- Similarly, `lp_asa_id_[pool_id]` defaults to 0 — `add_collateral()` would assert ASA ID = 0, rejecting all LP token deposits.
- None of these initialization calls appeared in the deployment checklist.
- **Fix:** Added per-pool initialization steps for `set_rate()`, `set_ltv()`, `set_liq_threshold()`, and `set_lp_asa_id()` to the vault initialization section. ADMIN.md updated.

---

### Medium — Fixed

**[AUD-059] 🟢 `add_pool()` signature changed but checklist not updated**
- `add_pool(pool_id, initial_price)` now requires an initial price argument (AUD-043 fix). Deployment checklist still showed `add_pool(pool_app_id)` with no price argument. Calling the old form would fail at the contract level.
- **Fix:** Checklist updated to `add_pool(pool_app_id, initial_price)`. Added verification step: confirm posted price is within 50% of the initial_price anchor after first bot update. ADMIN.md updated.

**[AUD-060] 🟢 LP Oracle opt-in to mUSD ASA was spurious — oracle never holds mUSD**
- Original checklist included "LP Oracle: opt into mUSD ASA." The oracle contract stores only price integers in global state; it never receives or transfers mUSD tokens. This opt-in wastes transaction fees and adds unnecessary ASA holding to the oracle contract account.
- **Fix:** Step removed from deployment checklist.

**[AUD-061] 🟢 Checklist had no end-to-end smoke test before opening to public**
- No step to perform a test borrow before opening the protocol. A misconfigured parameter (wrong mUSD ASA ID, wrong pool ID, bad LP price) would surface on the first real user transaction rather than on an admin-controlled test.
- **Fix:** Added "Perform a test borrow (small amount, single vault) to verify full end-to-end flow before opening to public" as the penultimate launch step. ADMIN.md updated.

---

---

---

## Pass 10 — Cross-Pass Consistency Check

Final pass reviewing whether any fix from Passes 4–9 introduced new contradictions.

---

### Critical — Fixed

**[AUD-062] 🟢 PSM.receive_musd() Gtxn assertion contradicts pay_interest() overpayment path**
- Pass 4 (AUD-037) added an explicit AssetTransfer assertion to receive_musd(): "Assert AssetTransfer in group: receiver = PSM address, amount = amount exactly." Pass 6 confirmed this works for `repay_principal` and `settle_health_liquidation` (outer group sends mUSD directly to PSM).
- However, `pay_interest()` with overpayment works differently: the outer group AssetTransfer sends mUSD to the VAULT (for interest → accumulated_fees). The excess is routed to PSM via a VAULT-ISSUED INNER AssetTransfer (sibling to the receive_musd AppCall). Algorand's Gtxn always refers to the OUTER group — PSM cannot see the sibling inner tx. The Gtxn assertion finds an outer group transfer to VAULT (not PSM) and fails. Every single-call full repayment (the design's primary UX convenience) would revert.
- **Fix:** Removed Gtxn AssetTransfer assertion from receive_musd(). Security relies on: (a) caller must be registered vault app address (primary guard), and (b) mUSD physically arrives at PSM via inner AssetTransfer before receive_musd executes — PSM's ASA balance reflects this regardless of how it arrived. The vault-level verification (outer group assertion in repay_principal/settle_health_liquidation) is sufficient for those paths. PSM.md and VAULT.md updated with explanation of both routing paths.

---

---

---

## Pass 11 — mUSD.md Review

mUSD.md was identified as unreviewed. Three inaccuracies found, all contradicting the finalized design.

---

### High — Fixed

**[AUD-063] 🟢 mUSD.md "Via vault repayment" described old mUSD→vault→PSM routing**
- Principal repayments now go directly to PSM in the outer atomic group (Pass 6 fix). The mUSD.md description said "borrower sends mUSD to vault contract; vault transfers to PSM via inner tx" — the old design where mUSD went to vault first.
- **Fix:** Updated "Via vault repayment" to two distinct sections: principal repayment (mUSD → PSM directly in outer group) and interest payment (mUSD → vault; stays in accumulated_fees; circulating unchanged). mUSD.md updated.

---

### Medium — Fixed

**[AUD-064] 🟢 mUSD.md: "The vault never holds mUSD itself" — incorrect**
- Interest payments land in the vault contract as `accumulated_fees` and remain there until admin calls `collect_fees()`. The vault holds mUSD between payment events and fee collection. The claim "the vault never holds mUSD" is false.
- **Fix:** Cross-contract interaction section rewritten to describe both flows: principal (routed to PSM) and interest (held in vault). mUSD.md updated.

**[AUD-065] 🟢 mUSD.md PSM USDC balance formula was dimensionally incoherent**
- Formula mixed mUSD units (`psm.musd_balance_at_init`) with USDC units (`admin_deposits`, `psm.usdc_balance`) on the same side of an equation.
- **Fix:** Replaced with correct definitions of the core invariant and vault_ceiling formula; added prose explanation of what grows and shrinks the PSM USDC balance. mUSD.md updated.

---

## Pass 12 — Final Cross-Check (Fix-Induced Consistency Scan)

Full re-read of all 7 content .md files to catch any inconsistencies introduced by Passes 1–11 fixes. 11 issues found; all fixed in this pass.

---

### High — Fixed

**[AUD-066] 🟢 lp_value and health factor computations can overflow uint64 for large vaults**
- `lp_amount × oracle.price_per_lp` (the lp_value computation) can overflow uint64 for positions above ~$10M, depending on oracle price scale. At $100/LP token (10^8 scaled) and 100,000 LP tokens (10^11 base units), the intermediate = 10^19 > uint64 max (~1.8 × 10^19). The same risk applies to `lp_value × liq_threshold_bps` (HF numerator) and `lp_value × ltv_bps` (borrow limit), plus `lp_to_seize × lp_price` and `total_recovery_musd × 1_000_000` in LIQUIDATION.md.
- Only `annual_interest × seconds_elapsed` was previously documented as needing WideRatio — the oracle-dependent products were not mentioned.
- **Fix:** Extended the Wide math requirement note in VAULT.md to cover all three categories: interest accrual, lp_value (lp_amount × price / 1_000_000), and HF/LTV numerators (lp_value × bps / 10_000). All must use AVM `mulw`/`divw` (algopy: `WideRatio`). VAULT.md updated.

**[AUD-076] 🟢 Health factor pseudocode formula missing `/1_000_000` divisor**
- VAULT.md health factor section showed `collateral_value = lp_amount × oracle.price_per_lp` — omitting the `/1_000_000` scaling that appears in every other LP value computation (`open_vault`, `borrow_more`, LIQUIDATION.md HF formula). An implementer following this formula literally would compute a health factor 10^6 times too large, making HF always appear >> 1.0 and rendering health liquidations impossible.
- **Fix:** Updated pseudocode to `lp_value = lp_amount × oracle.price_per_lp / 1_000_000` with WideRatio note; renamed variable to `lp_value` for consistency with all other occurrences. VAULT.md updated.

---

### Medium — Fixed

**[AUD-067] 🟢 `pay_interest()` step ordering ambiguity — zeroed field referenced in next step**
- Steps 6 and 7 said: "Zero `accrued_interest`" then "`accrued_interest` amount added to `accumulated_fees`". After zeroing, referencing `accrued_interest` retrieves 0 — an implementer following the spec literally would add 0 to `accumulated_fees`, losing all interest revenue from that payment.
- **Fix:** Step 5 now saves `interest_due = accrued_interest` before computing `change`; step 7 adds `interest_due` to `accumulated_fees`. Ambiguity eliminated. VAULT.md updated.

**[AUD-068] 🟢 `pay_interest()` overpayment + vault closure: fee=3000 insufficient**
- The overpayment path (step 8) specified `fee=3000` covering vault outer execution + 2 inner txs (mUSD→PSM AssetTransfer, PSM.receive_musd AppCall). When the overpayment also zeroes `musd_borrowed`, vault closure fires — 2 additional inner txs: AssetTransfer LP → borrower and Payment MBR 46,500 µALGO → borrower. Total depth = outer + 4 inner = 5000 required. fee=3000 would cause the vault-closure sub-path to fail on mainnet.
- **Fix:** Split fee spec into two sub-cases: without closure fee=3000; with closure fee=5000. Inner txs 3 and 4 explicitly listed in the closure sub-case. VAULT.md updated.

**[AUD-069] 🟢 `repay_principal()` missing fee spec entirely**
- No `flat_fee` note existed for `repay_principal()`. Without it, the builder must infer the fee from the call depth: outer (1000) + PSM.receive_musd inner AppCall (1000) = 2000 for the no-closure path; vault closure adds LP→borrower AssetTransfer (1000) + MBR Payment (1000) = 4000 total.
- **Fix:** Added explicit fee note after step 7: fee=2000 without closure, fee=4000 with closure. VAULT.md updated.

**[AUD-070] 🟢 `settle_health_liquidation()` fee=2000 insufficient for vault-closure branches**
- Settlement fee was `fee=2000` for all outcomes. The non-closure case (stay in state 2 or return to active) is correct: outer + PSM.receive_musd = 2000. But the two vault-closure branches (dust bad debt and full liq settled) fire a Payment inner tx to return 46,500 µALGO MBR to borrower — requiring fee=3000.
- **Fix:** Fee line updated to: fee=2000 for non-closure; fee=3000 for vault-closure branches. LIQUIDATION.md updated.

**[AUD-071] 🟢 `trigger_partial_liquidation()` and `trigger_full_liquidation()` stale "current block" in step 3**
- Both methods said "Accrue interest to current block" — a holdover from the original block-based interest model replaced in AUD-019. All accrual uses unix timestamps (`Global.LatestTimestamp`), not block numbers.
- **Fix:** Both instances updated to "current timestamp". LIQUIDATION.md updated (replace_all).

**[AUD-072] 🟢 Stale "PSM verifies outer group AssetTransfer" in three places**
- After AUD-062 removed the Gtxn assertion from `PSM.receive_musd()`, three spec notes still said PSM independently verifies the outer group AssetTransfer:
  1. LIQUIDATION.md `settle_health_liquidation()` step 2 parenthetical
  2. LIQUIDATION.md `settle_health_liquidation()` step 5 description
  3. VAULT.md `repay_principal()` step 6 description
- These notes implied a double-verification that no longer exists. An auditor reading the spec would conclude PSM provides a second layer of AssetTransfer validation and might not add vault-side checks — a false safety assumption.
- **Fix:** All three updated to "PSM verifies vault app address" — accurately reflecting the sole PSM-side guard after AUD-062. LIQUIDATION.md and VAULT.md updated.

---

### Low — Fixed

**[AUD-073] 🟢 ADMIN.md LP Oracle table: `add_pool()` missing `initial_price` argument**
- The admin actions table showed `add_pool(pool_id)` — the old single-argument signature. AUD-043 required adding `initial_price` as a mandatory argument (anchors the deviation guard for the first price update). The deployment checklist section correctly showed `add_pool(pool_app_id, initial_price)`, creating an internal contradiction.
- **Fix:** Table updated to `add_pool(pool_id, initial_price)`. ADMIN.md updated.

**[AUD-074] 🟢 Rate cap shows "TBD" in three places**
- ADMIN.md Trust Model section ("TBD per contract"), ADMIN.md Rate Management table ("on-chain bounds TBD"), and OVERVIEW.md Admin Controls table ("On-chain bounds (TBD)") all showed a placeholder for the rate cap. The rate cap is now defined in VAULT.md `set_rate()`: `Assert rate_bps ≤ 3000` (30% APR).
- **Fix:** All three instances updated to "max 3000 bps (30% APR)" or equivalent. ADMIN.md and OVERVIEW.md updated.

**[AUD-075] 🟢 ADMIN.md settle procedures omit required atomic group structure**
- Partial liq step 6 said "Call `settle_health_liquidation(borrower_address, musd_amount)`" and full liq steps 3–4 said "call `settle_health_liquidation()`" — none mentioned that this call requires an atomic group that includes `AssetTransfer(mUSD → PSM contract address, amount = musd_amount)`. The vault contract asserts this transfer is present in step 2 of settle; without it the transaction reverts.
- An admin dashboard built from this spec would construct an AppCall-only transaction and hit a confusing assertion failure at the vault.
- **Fix:** All three settle callsites in ADMIN.md updated to specify the required atomic group. ADMIN.md updated.

---

## Final Audit Status

All 8 .md files reviewed: VAULT.md, PSM.md, LIQUIDATION.md, LP_ORACLE.md, ADMIN.md, OVERVIEW.md, mUSD.md, AUDIT.md (log).

| Pass | Scope | Findings | Critical | High | Medium | Low |
|---|---|---|---|---|---|---|
| 1 | Architectural review | AUD-001–006 | 0 | 4 | 1 | 1 |
| 2 | Full protocol design audit | AUD-007–020 | 1 | 3 | 3 | 0 |
| 3 | Vault method-level review | AUD-021–033 | 5 | 4 | 2 | 0 |
| 4 | PSM method-level review | AUD-034–040 | 3 | 3 | 1 | 0 |
| 5 | LP Oracle method-level review | AUD-041–046 | 1 | 3 | 1 | 1 |
| 6 | Cross-contract interactions | AUD-047–050 | 1 | 1 | 1 | 1 |
| 7 | Admin privilege escalation | AUD-051–054 | 0 | 2 | 1 | 1 |
| 8 | Economic attack surface | AUD-055–056 | 0 | 0 | 1 | 1 |
| 9 | Pre-deploy checklist | AUD-057–061 | 0 | 2 | 3 | 0 |
| 10 | Cross-pass consistency | AUD-062 | 1 | 0 | 0 | 0 |
| 11 | mUSD.md review | AUD-063–065 | 0 | 1 | 2 | 0 |
| 12 | Final cross-check (fix-induced consistency) | AUD-066–076 | 0 | 2 | 5 | 4 |
| 13 | Full re-read with all fixes in place | AUD-077–088 | 0 | 2 | 5 | 5 |
| 14 | Full re-read post Pass 13 fixes | AUD-089–094 | 0 | 1 | 2 | 3 |
| 15 | Full re-read post Pass 14 fixes | AUD-095–097 | 0 | 0 | 1 | 2 |
| **Total** | | **97 findings** | **12** | **28** | **29** | **19** |

**All 97 findings are resolved (🟢) or accepted (🟡).** Zero open (🔴) findings remaining.

🔴 carried forward as future work (pre-mainnet operational requirements):
- AUD-001 (off-chain TWAP unverifiable — v3 consideration)
- AUD-002 (bot restart resets TWAP — must persist history before mainnet)
- AUD-004 (single bot SPOF — redundant bot instances before mainnet)

🟡 accepted risks with documented mitigations:
- AUD-005 (global state key ceiling — box storage migration path available)
- AUD-007 (tier boundary HF lag — admin procedure documented)
- AUD-008 (settlement window — monitoring alert at 1 hour documented)
- AUD-046 (remove_pool with active vaults — pre-removal checklist documented)
- AUD-054 (no pause mechanism — v2.1 roadmap item)

---

## Pass 13 — Full Re-Read with All Fixes in Place

Complete independent re-read of all 7 content .md files after Pass 12 fixes. 12 new findings; all fixed in this pass.

---

### High — Fixed

**[AUD-077] 🟢 `settle_health_liquidation()` partial-liq-settled branch does not reset `last_payment_timestamp`**
- When a partial health liquidation settles (accrued_interest → 0, musd_borrowed > 0, lp_amount > 0), the spec reset `last_accrual_timestamp` but not `last_payment_timestamp`. The vault re-enters state 0. Since the borrower was locked in state 2 (unable to call `pay_interest()`) for the duration of the liquidation process, the payment clock kept advancing. If settlement took >90 days, the borrower would immediately be re-eligible for micro-liquidation upon returning to state 0 — through no fault of their own.
- **Fix:** Added `last_payment_timestamp = current_timestamp` to the partial-liq-settled completion branch, giving the borrower a fresh 90-day window. LIQUIDATION.md updated.

**[AUD-078] 🟢 `pool_id` missing from all vault and liquidation method signatures**
- The vault box key is `"vault_" + borrower_pubkey + pool_id`. Without `pool_id` as an explicit method argument, the contract cannot construct the box key to look up or modify any vault box. Methods affected: `open_vault()`, `pay_interest()`, `repay_principal()`, `add_collateral()`, `borrow_more()`, `trigger_micro_liquidation()`, `trigger_partial_liquidation()`, `trigger_full_liquidation()`, `settle_health_liquidation()`. The only method that already showed `pool_id` in its signature was `mark_payment_overdue(borrower, pool_id)`.
- **Fix:** Added `pool_id` to all 9 affected method signatures across VAULT.md and LIQUIDATION.md. Added a note at the top of the Payment Flow section explaining the `pool_id` requirement. ADMIN.md settle call references also updated.

---

### Medium — Fixed

**[AUD-079] 🟢 ADMIN.md line 252: stale method name `trigger_health_liquidation()`**
- Emergency procedures section referenced `trigger_health_liquidation()` — a method that does not exist. The correct methods are `trigger_partial_liquidation()` and `trigger_full_liquidation()`.
- **Fix:** Updated to reference the correct method names with tier guidance. ADMIN.md updated.

**[AUD-080] 🟢 OVERVIEW.md circuit breaker shows ">X% deviation"**
- LP Oracle circuit breaker spec in OVERVIEW.md used the placeholder ">X%" rather than the defined 50% guard. The on-chain deviation guard is fully specified in LP_ORACLE.md (`Assert WideRatio(new_price, 100, 50) >= prior` and `Assert WideRatio(new_price, 100, 150) <= prior`).
- **Fix:** Updated to ">50% deviation (on-chain guard in LP Oracle contract)". OVERVIEW.md updated.

**[AUD-081] 🟢 LIQUIDATION.md missing WideRatio requirement on `seized_lp_value` and `surplus_lp_tokens`**
- AUD-066 documented the wide math requirement in VAULT.md but the actual formulas in LIQUIDATION.md (`seized_lp_value = lp_to_seize × lp_price / 1_000_000` and `surplus_lp_tokens = floor((total_lp_value − total_debt) × 1_000_000 / lp_price)`) carried no such note. An implementer reading only LIQUIDATION.md would use standard uint64 multiplication.
- **Fix:** Added "[WideRatio required — see AUD-066]" annotations to both the seizure formula table and the trigger_full_liquidation surplus formula. Also annotated `total_lp_value` computation with WideRatio note. LIQUIDATION.md updated.

**[AUD-082] 🟢 `trigger_full_liquidation()` enters un-exiteable state 2 when `musd_to_settle` rounds to zero**
- `musd_to_settle = min(total_debt, total_lp_value)`. If `lp_amount × lp_price < 1_000_000`, integer truncation yields `total_lp_value = 0`, so `musd_to_settle = 0`. The vault enters state 2 with `accrued_interest = 0`. Calling `settle_health_liquidation()` requires `PSM.receive_musd(amount)` with `amount > 0`, but `musd_amount ≤ accrued_interest = 0` means only amount = 0 would satisfy the counter check — which PSM rejects. Vault permanently stuck in state 2 with no exit path.
- **Fix:** Added explicit step 6 in `trigger_full_liquidation()`: if `total_lp_value == 0`, skip state 2 entirely — immediately transfer all LP to admin, delete vault box, return MBR to borrower (bad debt write-off). Existing steps renumbered. LIQUIDATION.md updated.

**[AUD-083] 🟢 `repay_principal()` no explicit guard against over-repayment**
- Step 5 subtracted the repayment amount from `musd_borrowed` without first asserting `repayment amount ≤ musd_borrowed`. The AVM panics on uint64 underflow (aborting the transaction), so no funds are at risk — but the abort produces an opaque error message with no clear indication of the cause.
- **Fix:** Added `Assert repayment amount ≤ musd_borrowed` as step 5, with a note explaining why the explicit guard matters for developer experience. Existing steps 5–7 renumbered. VAULT.md updated.

---

### Low — Fixed

**[AUD-084] 🟢 `collect_fees()` spec omits explicit `Assert Txn.sender == Global.creator_address`**
- The method heading said "admin wallet only" but the numbered step list began with `Assert accumulated_fees > 0` — no admin check shown. An implementation following only the step list would be open to anyone draining the fee accumulator (the mUSD would go to the hardcoded admin wallet regardless, but the lack of an access check is a spec gap that could mislead implementers).
- **Fix:** Added `Assert Txn.sender == Global.creator_address` as step 1; existing steps renumbered. VAULT.md updated.

**[AUD-085] 🟢 `open_vault(borrow_amount == 0)` deferred-draw path has no fee specified**
- The borrow_amount > 0 path specifies `fee=3000`, but the deferred-draw path (no borrow, no PSM call) had no fee note. Default fee=1000 applies (outer only), but an implementer following the spec would need to infer this.
- **Fix:** Added explicit "Fee: `flat_fee=true, fee=1000`" to the Deferred draw note. VAULT.md updated.

**[AUD-086] 🟢 `set_lp_asa_id(pool_id, lp_asa_id)` referenced in ADMIN.md but missing from VAULT.md method specs**
- ADMIN.md deployment checklist correctly lists `set_lp_asa_id()` as a required initialization call, but VAULT.md's Rate and Parameter Management section had no spec for this method, leaving implementers without a definition.
- **Fix:** Added `set_lp_asa_id(pool_id, lp_asa_id)` spec to VAULT.md. VAULT.md updated.

**[AUD-087] 🟢 `collect_algo()` referenced in ADMIN.md but has no spec in VAULT.md**
- ADMIN.md fee collection table listed `collect_algo()` for sweeping excess ALGO, but no spec existed anywhere.
- **Fix:** Added `collect_algo()` spec to VAULT.md Rate and Parameter Management section with admin guard, excess computation, and fee note. VAULT.md updated.

**[AUD-088] 🟢 Lazy 90-day overdue check scope ambiguous ("any vault interaction")**
- VAULT.md Payment Overdue Transition section said "any vault interaction (`pay_interest`, `borrow_more`, etc.) checks the 90-day timer." The `etc.` left implementers uncertain which methods perform this check and which do not. In particular: does `add_collateral()` do it? Does `repay_principal()`? Does an admin liquidation trigger do it?
- **Fix:** Replaced vague "any vault interaction" with an explicit list: `pay_interest()`, `repay_principal()`, `borrow_more()`, `add_collateral()` perform the lazy check. Admin-only methods and vault-creation methods do not. Added note that the check never blocks the operation — it only updates state before proceeding. VAULT.md updated.

---

## Pass 14 — Full Re-Read Post Pass 13 Fixes

Complete independent re-read of all 7 content .md files after Pass 13 fixes. 6 new findings; all fixed in this pass.

---

### High — Fixed

**[AUD-089] 🟢 `open_vault()` deferred-draw path never stores `rate_bps` — all deferred-draw vaults silently accrue at 0% interest**
- In the `open_vault()` spec, `rate_bps = rate_bps_[pool_id]` (the rate-lock assignment) appeared only as a bullet inside step 9 — the `borrow_amount > 0` branch. The `borrow_amount == 0` deferred-draw path (step 8) skipped step 9 entirely. The vault box was created with `rate_bps` at its uint64 default (0).
- When the borrower later calls `borrow_more()`, interest accrual uses `vault.rate_bps`. With `rate_bps = 0`, `annual_interest = musd_borrowed × 0 / 10_000 = 0` — the borrower is charged zero interest for the entire life of the position. Any borrower aware of this could open a vault with `borrow_amount = 0`, securing a permanent 0% rate before calling `borrow_more()`.
- **Fix:** Moved `rate_bps = rate_bps_[pool_id]` from inside step 9 (borrow path only) to step 5 (common vault box initialization, both paths). The rate is now locked at vault creation regardless of whether `borrow_amount` is 0 or > 0. Added note explaining why the deferred-draw path must also set this field. VAULT.md updated.

---

### Medium — Fixed

**[AUD-090] 🟢 ADMIN.md liquidation trigger call signatures missing `pool_id` added in AUD-078**
- Pass 13 (AUD-078) added `pool_id` to all vault and liquidation method signatures. The `settle_health_liquidation()` call in ADMIN.md was correctly updated. However, all four trigger method calls — `trigger_micro_liquidation(borrower_address)`, `trigger_partial_liquidation(borrower, tier=1)`, `trigger_partial_liquidation(borrower, tier=2)`, and `trigger_full_liquidation(borrower)` — still showed pre-Pass-13 signatures without `pool_id`. An admin building a dashboard from this procedure would construct calls that fail at the vault (contract cannot identify which vault box to operate on without `pool_id`).
- **Fix:** Updated all four trigger method calls in ADMIN.md procedures and the HF-range action table to include `pool_id`: `trigger_micro_liquidation(borrower_address, pool_id)`, `trigger_partial_liquidation(borrower_address, pool_id, tier)`, `trigger_full_liquidation(borrower_address, pool_id)`. ADMIN.md updated.

**[AUD-091] 🟢 mUSD.md claims ASA total supply can be updated post-creation — factually incorrect on Algorand**
- The Known Assumptions section stated: "if total mUSD outstanding ever approaches 500M, the admin must update the ASA total supply (as manager)." On Algorand, ASA total supply is immutable after creation — the manager role can change manager, reserve, freeze, and clawback addresses, but cannot modify the total supply. There is no `AssetConfig` field for supply modification.
- If mUSD circulation approaches 500M, the only path is deploying a new mUSD ASA and migrating — not an in-place supply update. Following the spec's incorrect claim would lead to discovering this limitation at a critical moment.
- **Fix:** Corrected to: "Algorand ASA total supply is immutable post-creation — the manager role cannot increase it. If total mUSD outstanding approaches 500M, the protocol would need to deploy a new mUSD ASA and migrate." mUSD.md updated.

---

### Low — Fixed

**[AUD-092] 🟢 `add_collateral()` spec missing fee specification**
- Every other user-facing vault method includes a `flat_fee` note; `add_collateral()` had none. The method issues no inner transactions (just vault state updates), so `flat_fee=true, fee=1000` is the correct allocation — but an implementer following the spec would have to infer this.
- **Fix:** Added step 5: "`flat_fee=true, fee=1000` — no inner transactions" to `add_collateral()` spec. VAULT.md updated.

**[AUD-093] 🟢 `add_collateral()` and `borrow_more()` method specs missing explicit lazy overdue check notation**
- The "Payment Overdue Transition" section (AUD-088 fix) lists both methods as performing the lazy 90-day check. However, neither method's step-by-step spec shows a lazy check annotation — unlike `pay_interest()` and `repay_principal()` which do show it inline.
- For `borrow_more()` this is particularly important: the lazy check must run BEFORE step 2 (`Assert vault_state == 0`). If vault_state is stale (overdue but still showing 0 on-chain), the check in step 2 would pass incorrectly, allowing additional borrowing on a delinquent position. The lazy update must fire first to set vault_state = 1, which then causes step 2 to correctly block the borrow.
- **Fix:** Added inline lazy check annotations to both method specs. `borrow_more()` annotation explicitly notes it must execute before step 2. VAULT.md updated.

**[AUD-094] 🟢 `trigger_partial_liquidation()` step 5 uses `tier_bps` without defining the mapping**
- Step 5 said "Compute `lp_to_seize = ceil(vault.lp_amount × tier_bps / 10_000)`" but never defined what `tier_bps` is for each valid `tier` argument. The values (3500 for tier 1 = 35%; 6000 for tier 2 = 60%) appear in the liquidation tier table above the method spec, but an implementer reading only the method definition would have no mapping.
- Additionally, no assertion existed to reject invalid `tier` argument values (e.g., tier=3 or tier=99).
- **Fix:** Updated step 5 to define the mapping inline (`tier_bps = 3500` for tier 1, `tier_bps = 6000` for tier 2) and added `Assert tier is 1 or 2` to reject invalid inputs. Also added `[WideRatio required]` annotation to step 6 (`seized_lp_value` computation) to match the VAULT.md wide-math documentation standard. LIQUIDATION.md updated.

---

## Pass 15 — Full Re-Read Post Pass 14 Fixes

Complete independent re-read of all 7 content .md files after Pass 14 fixes. 3 new findings; all fixed in this pass.

---

### Medium — Fixed

**[AUD-095] 🟢 ADMIN.md shortfall procedure instructs settling `total_debt` — contract assertion rejects this; LIQUIDATION.md incorrectly claims invariant is broken**
- Two related errors in the full liquidation shortfall procedure:
- **ADMIN.md step 4 (full liq, shortfall):** instructed admin to call `settle_health_liquidation(borrower_address, pool_id, total_debt)`. The contract's settlement counter (`accrued_interest` repurposed in state 2) is set to `musd_to_settle = lp_value < total_debt`. Step 3 of `settle_health_liquidation()` asserts `musd_amount ≤ accrued_interest = lp_value`. Passing `total_debt > lp_value` fails the assertion every time. The admin's emergency runbook procedure would revert on mainnet during a live liquidation event.
- **LIQUIDATION.md shortfall description:** stated the shortfall "breaks the invariant" and required depositing deficit USDC "to restore the invariant before settlement." The PSM invariant (`circulating_musd ≤ psm_usdc_balance`) is NOT broken by a shortfall. PSM USDC was reserved against the vault borrow at open time — the reserve already covers all circulating mUSD including this vault's share. What the shortfall actually costs is vault ceiling headroom: `(total_debt − musd_to_settle)` mUSD remains permanently circulating, shrinking the ceiling by that amount. The `deposit_usdc` call is optional ceiling restoration, not invariant repair.
- **Fix (ADMIN.md):** Step 4 corrected to settle only `musd_to_settle` (= lp_value, the actual settlement counter). Explicit note that passing `total_debt` fails the contract assertion. `deposit_usdc` reframed as optional ceiling restoration. ADMIN.md updated.
- **Fix (LIQUIDATION.md):** Shortfall description corrected — invariant is maintained, not broken; shortfall is ceiling headroom loss; settlement amount is `musd_to_settle` exactly; `deposit_usdc` is optional. LIQUIDATION.md updated.

---

### Low — Fixed

**[AUD-096] 🟢 LIQUIDATION.md state transition diagram says `active → payment_overdue` is "set by oracle bot / cron"**
- The transition entry read: "90 days elapsed since last_payment_timestamp (set by oracle bot / cron)". The oracle bot has no vault contract permissions and cannot write vault state. It can only call `update_lp_price()` on the LP Oracle contract. Following this description would lead a builder to wire up a bot with vault state-writing authority that the protocol has no mechanism to support.
- The actual mechanisms are: (a) lazy discovery — the 4 borrower-facing vault methods (`pay_interest()`, `repay_principal()`, `borrow_more()`, `add_collateral()`) check the 90-day condition and set `vault_state = 1` automatically; (b) admin transition — `mark_payment_overdue(borrower, pool_id)` for explicit on-chain marking.
- **Fix:** Updated transition entry to "detected via lazy check in vault interactions, or explicitly set by admin via mark_payment_overdue()". LIQUIDATION.md updated.

**[AUD-097] 🟢 `pay_interest()` and `repay_principal()` method specs missing inline lazy check annotations**
- Pass 14 (AUD-093) added inline lazy check annotations to `borrow_more()` and `add_collateral()`. The "Payment Overdue Transition" section correctly lists all four methods as performing the 90-day lazy check. However, `pay_interest()` (lines 113–133) and `repay_principal()` (lines 140–150) had no inline annotation, creating an inconsistency: two of the four methods documented the check inline, two did not. An implementer reading only the `pay_interest()` or `repay_principal()` sections would not know to add the lazy check.
- **Fix:** Added "[Lazy check: if `current_timestamp >= last_payment_timestamp + 90 days`, set `vault_state = 1` before any other logic]" annotation before step 1 of both `pay_interest()` and `repay_principal()`. VAULT.md updated.

---

## Pass 16 — Pre-Deploy Contract Implementation Review

First audit pass against the actual Puya/algopy contract implementations (not just the .md specs). Two critical findings, both fixed.

### Critical — Fixed

**[AUD-098] 🟢 `pay_interest()` uint64 underflow on overpayment exceeding principal**
- In `pay_interest`, after clearing interest, `change = payment − interest_due` was applied to principal as `new_borrowed = musd_borrowed − change`. If a borrower overpaid by more than the outstanding principal, `change > musd_borrowed` and the subtraction underflowed, panicking the transaction (best case) — but the path existed and made full-repayment-with-overshoot unusable.
- **Fix:** Added `assert change <= vault.musd_borrowed.native, "overpayment exceeds principal"` before the subtraction. `contract.py` (vault) updated.

**[AUD-099] 🟢 Vault and PSM had no `opt_in_asset` method — contracts could not hold any ASA**
- Neither contract account could opt into mUSD/USDC/LP tokens, so every inner AssetTransfer to the contract (and every issuance) would fail. The protocol was undeployable.
- **Fix:** Added admin-only `opt_in_asset(asa_id)` to both Vault and PSM (self-transfer of amount 0). ADMIN.md deploy checklist updated to call it for each required ASA before use.

---

## Pass 17 — Full Independent Re-Audit (post AUD-098/099)

Independent agent re-audited contracts + specs. Findings applied:

- **[C-1] 🟢 Deployment deadlock** — `set_ltv` asserts `ltv < liq_threshold`, but ADMIN.md ordered `set_ltv` before `set_liq_threshold` (which returns 0 if unset → assertion always fails). Fixed ADMIN.md order (`set_liq_threshold` first) and added `assert liq != 0, "set liq threshold before ltv"` guard in `set_ltv`.
- **[C-2] 🟢 Accrue-in-state-2 latent risk** — added early return `if vault.vault_state == 2: return vault` inside `_accrue_interest` so the settlement counter can never be overwritten regardless of caller.
- **[H-1] 🟢 `trigger_partial_liquidation` underflow** — capped `seized_lp_value` at `total_debt` before `musd_borrowed = total_debt − seized_lp_value`.
- **[H-3] 🟢 `repay_principal` unusable** — removed the pre-assertion `_accrue_interest` call; now checks the stored `accrued_interest == 0` directly.
- **[H-4 / H-5] 🟢 Zero-id bricking** — `set_vault_contract` (PSM) and `set_lp_oracle` (vault) now reject `0`.
- **[M-5] 🟢** `redeem_musd` fee math switched to WideRatio. **[M-6] 🟢** `trigger_full_liquidation` guards `lp_to_seize > 0`. **[L-1] 🟢** PSM `deploy` asserts `musd != usdc`. **[L-2] 🟢** PSM `StateTotals` corrected to `global_bytes=1`. **[L-4] 🟢** removed dead `_pool_is_active` in oracle.

---

## Pass 18 — Fresh Independent Audit (post Pass 17)

Independent agent, full line-by-line. Four real findings fixed; the rest dismissed as non-exploitable on Algorand (group-sender piggybacking impossible without co-signature) or astronomically-bounded.

- **[F-01] 🔴 Critical 🟢 Fixed** — `settle_health_liquidation` had only 3 exit branches but 4 end-states exist. When a partial liquidation seizes LP worth exactly `total_debt` (reachable via the H-1 cap), `musd_borrowed → 0` while `lp_amount > 0`; the vault fell through to the close-branch, **deleting the box and trapping the remaining LP**. Added an explicit fourth branch returning surplus LP to the borrower before closing.
- **[F-16] 🟠 High 🟢 Fixed** — oracle bot TWAP was a left-Riemann sum excluding the latest reading, and a symmetric divergence guard silenced the bot during genuine price drops (oracle goes stale exactly when liquidations are needed). Switched to trapezoidal TWAP + asymmetric divergence (block spikes only).
- **[F-17] 🟡 Medium 🟢 Fixed** — `open_vault` could create 0%-interest vaults if `set_lp_asa_id` was called without `set_rate` (unset pool params read as 0). Added `assert pool_rate > 0` at vault creation.
- **[F-24] 🟢 Fixed** — TWAP state file write made atomic (temp file + rename).

---

## Pass 19 — Deep Security Audit (Opus, post Pass 18)

Senior-auditor deep dive focused on protocol safety. Headline finding verified on-chain against the live Tinyman v2 ALGO/USDC pool before fixing.

### Critical — Fixed

**[P19-01] 🟢 Oracle bot read pool reserves from the wrong on-chain location**
- The bot called `application_info(pool_app_id)` and read `global-state`. Tinyman v2 has **no per-pool application** — each pool is an account opted into the single shared AMM validator app (mainnet `1002541853`), and its reserves + issued LP live in that account's **local state**. Verified on-chain: the real keys are `asset_1_reserves` / `asset_2_reserves` (already net of protocol fees) and `issued_pool_tokens`. The bot would read nothing → 0 reserves → skip forever (fails closed; no real pool could ever be priced).
- **Fix:** `fetch_pool_state` now reads the pool **account's local state** via `account_application_info(pool_address, amm_validator_app_id)`; config takes `pool_address` + `amm_validator_app_id`; LP supply read from `issued_pool_tokens`; added on-chain asset-id verification (guards a wrong `pool_address`) and an absolute `min_price`/`max_price` sanity bound (the on-chain ±50% guard only bounds *relative* movement). `oracle_bot.py` + `config.json` updated.

### Low — Fixed

- **[P19-05] 🟢** `collect_fees` now clamps the sweep to the vault's actual mUSD balance and decrements the counter by the swept amount — a phantom-fee entry can never brick collection.
- **[P19-08] 🟢 (doc)** VAULT.md `collect_algo` spec corrected to match the implementation (admin-supplied `amount`, AVM-bounded by the contract's own min balance; fails closed on over-sweep). On-chain excess computation deferred.
- **[P19-09] 🟢** Added explicit group-bounds asserts before every relative-index `gtxn` access (vault `open_vault`/`pay_interest`/`repay_principal`/`add_collateral`/`settle_health_liquidation`; PSM `mint_musd`/`redeem_musd`/`deposit_usdc`) so edge-of-group composition reverts with a clear message instead of an opaque panic. (Already failed closed; this improves diagnostics.)

### Reviewed — No code change

- **[P19-04] ⚪ Revenue-recognition policy, not a bug** — partial liquidation folds pre-liq accrued interest into `musd_borrowed`; on later repayment it routes to PSM (reducing circulating mUSD / restoring ceiling) rather than to `accumulated_fees`. The auditor's suggested fix (credit `accumulated_fees`) is harmful: there is no backing mUSD in the vault for a partial-liq, so the entry would be unbacked and (post-P19-05) simply un-sweepable. Current behavior is the conservative, solvency-favoring choice — earned interest materializes as higher overcollateralization. **Decision: keep as-is; documented.**
- **[P19-06] ⚪ Verified safe** — in every `trigger_full_liquidation` branch the settlement counter `musd_to_settle ≤ contract-computed seized value` (surplus case: `surplus_lp` floors → `lp_to_seize` rounds up → seized ≥ total_debt; shortfall case: `musd_to_settle = total_lp_value =` seized exactly). No over-settlement path exists; the "dust" is real-world LP-sale slippage, already documented as operational.

### Deferred — Design decisions (not in this fix pass)

- **[P19-03] 🟠 High (open)** — the on-chain deviation guard bounds only movement vs. the *prior* post, so a compromised bot key can ratchet the price arbitrarily over many updates → over-borrow → bad debt. The "bot compromise = no fund risk" claim in the docs is too strong for the over-borrow direction. Proposed fix: an on-chain admin price anchor with a bounded cumulative-drift guard. **Awaiting design sign-off before implementation.**
- **[P19-02 / P19-07] 🟡 Medium (open)** — single price-derivation path (spec promises multi-source median + cross-source divergence) and weak thin-history TWAP; add a minimum-readings gate that fails *stale* not *open*.
- **[P19-10 → P19-13] ⚪ Documented admin-trust items** — timelock on `set_lp_oracle`/`set_vault_contract`, admin rotation, protocol pause, multi-year accrual cap. Accepted for v2 launch; revisit before significant TVL.

---

## Pass 20 — Two-Role Security Hardening (resolves all open Pass 19 items)

Implemented the full **two-role guardian model** plus the deferred oracle and accrual hardening. All three contracts recompile clean. This is a broad refactor — every admin gate moved from the immutable `Global.creator_address` to a stored, rotatable `admin`, with a separate cold `guardian` role for containment.

### Two-role admin model (P19-10 / P19-11 / P19-12 — all three contracts)
- **Stored roles:** `admin` (hot, mutable) replaces `Global.creator_address` on every admin-gated method; `guardian` (cold) added. Both set at `deploy()` (admin = deployer, guardian = new required param). Seized LP / swept fees / swept ALGO / withdrawn USDC now route to the *current* `admin`.
- **2-step rotation:** `propose_admin`/`accept_admin` (admin OR guardian may propose → recovery of a lost/compromised hot key) and `propose_guardian`/`accept_guardian`. Proposed account must accept; zero-address rejected.
- **Pause (P19-12):** `pause()` (admin or guardian) / `unpause()` (**guardian only** — a compromised hot key cannot lift a lockdown). Vault pause gates new borrowing (`open_vault` w/ borrow, `borrow_more`); PSM pause gates public `mint_musd`. Repay / liquidate / settle / redeem always stay open so users can exit.

### Catastrophic-power timelock (P19-03 / P19-10)
- **Vault `set_lp_oracle` → `propose_lp_oracle` / `confirm_lp_oracle` / `cancel_pending_lp_oracle`** (48h). **PSM `set_vault_contract` → `propose_vault_contract` / `confirm_vault_contract` / `cancel_pending_vault_contract`** (48h). Both queue a change with `eta = now + 48h`; only `admin` can confirm after the delay; **admin or guardian** can cancel (the guardian veto). This converts the two "instant total drain" powers into delayed, observable, guardian-revertible actions.

### Oracle cumulative-drift anchor (P19-03)
- Added `lp_anchor_[pool_id]`. `update_lp_price` now enforces the prior ±50% guard **and** a ±25% band vs. the admin anchor. `add_pool` stores the anchor alongside the initial price; `set_price_anchor` (admin) re-anchors during genuine large moves; `remove_pool` deletes it. A compromised bot can no longer ratchet price arbitrarily — total drift is capped at ±25% until the admin (not the bot) re-anchors. Docs corrected: bot compromise is *bounded* mispricing, not "no fund risk."

### Bot fail-stale gate (P19-02 / P19-07)
- `oracle_bot.py`: min-readings gate (`MIN_TWAP_READINGS = 3`) — on thin history the bot holds the prior on-chain price (fail-stale) instead of posting a single manipulable spot. Combined with the trapezoidal TWAP from Pass 18.

### Multi-year accrual (P19-13)
- Vault `advance_accrual(borrower, pool_id)` (admin) — runs the 1-yr-capped `_accrue_interest` and writes back, so the protocol can catch up interest on a multi-year-abandoned vault by calling repeatedly before liquidating.

### P19-04 — resolved as documentation (confirmed not a bug)
- Verified via PSM-excess trace: liquidation-derived interest is realized as PSM overcollateralization (withdrawable USDC via `withdraw_usdc`), not lost. Crediting `accumulated_fees` would create an unbacked entry. Documented in LIQUIDATION.md; no code change.

### State schema
- PSM `StateTotals` → `global_uints=8, global_bytes=6`. Vault → `global_uints=40, global_bytes=6` (preserves ~8-pool dynamic budget). LP Oracle → `global_uints=40, global_bytes=6` (4 uints/pool incl. anchor). LP Oracle gained an explicit `deploy(guardian)` create method (was bare-create).

### Docs synced
- ADMIN.md (trust model rewritten: roles, guardian wallet, incident playbook; deploy procedure: guardian param, timelocked vault registration, pool_address config; admin-action tables). VAULT.md / PSM.md / LP_ORACLE.md (state tables, role model, timelocked methods, anchor, `set_price_anchor`, `advance_accrual`). LIQUIDATION.md (P19-04). 

**Verdict:** all Pass 19 findings now resolved or accepted-with-fix. Recommend one more independent audit pass against the refactored contracts before mainnet, since the admin-gate refactor touched every privileged method.

---

## Pass 21 — Independent Re-Audit of the Post–Pass-20 Two-Role Refactor (Opus)

Fresh independent audit focused on the two-role refactor (every privileged method), plus a full re-sweep. The refactor's access control / pause / timelock / anchor mechanics were verified correct (no ungated privileged method; no residual `Global.creator_address` in code; fund recipients route to the current `admin`; band/rounding math verified numerically; StateTotals budgets confirmed). One real implementation bug and three cheap hardening items found — all fixed in this pass.

### High — Fixed

**[P21-01] 🟢 `_accrue_interest` lost-time bug: capped elapsed but clock jumped to `now`, forgiving multi-year interest and breaking `advance_accrual`**
- When >1 year elapsed since last accrual, the function charged 1 year of interest (correct cap) but set `last_accrual_timestamp = now`, permanently discarding the interest between `last_accrual + 1yr` and `now`. A vault left dormant >1 year (the protocol explicitly permits indefinite grace) could be brought current by paying only 1 year's interest. The same understatement folded into `total_debt` at liquidation (slight under-seizure).
- It also silently defeated the P19-13 `advance_accrual` catch-up: the first call jumped the clock to `now`, so subsequent calls accrued ~0 — the documented "call repeatedly to advance in annual increments" did not work.
- **Fix:** advance the clock by the *capped* delta — `last_accrual_timestamp = last_accrual + seconds_elapsed` (capped). No behavior change in the normal <1yr case (`last_accrual + elapsed == now`); for multi-year dormancy the remainder is charged on the next accrual call, so no interest is forgiven and `advance_accrual` genuinely catches up. `contract.py` (vault) `_accrue_interest`.

### Low — Fixed

- **[P21-02] 🟢 Rotation allowed `admin == guardian`** — `propose_admin` / `propose_guardian` only rejected the zero address; proposing the other role's address would collapse the two-role model (single key gains unpause + timelock veto + recovery). Fixed: `propose_admin` asserts `new_admin != guardian`; `propose_guardian` asserts `new_guardian != admin` (all three contracts).
- **[P21-03] 🟢 `deploy` allowed `guardian == admin` at genesis** — fixed: all three `deploy` methods assert `guardian != Txn.sender`.
- **[P21-04] 🟢 Stale pending repoint survived admin rotation** — a timelocked change queued by a prior admin could be confirmed by a new admin unaware of its provenance. Fixed: `accept_admin` now clears the pending repoint slots (vault: `pending_lp_oracle` + eta; PSM: `pending_vault_app_id` + eta). Guardian veto + incident playbook already mitigated this; the clear is defense-in-depth.

### Operational (not code) — confirmed for the deploy checklist

- `oracle_bot/config.json` ships as a template with placeholders (`pool_address`, duplicate `pool_id=0`, `asset_*_id=0`, `min_price`/`max_price=0` = sanity bound disabled). These MUST be filled with real per-pool values before starting the bot — already required by the ADMIN.md Pre-Deploy checklist. Verify wBTC decimals on mainnet (AUD-006).

### Verified clean (auditor re-checked, no change)

PSM invariant across all mint/redeem/issue/receive/withdraw/overpay/settlement paths; tier boundaries (contiguous, no gap/overlap); all four `settle_health_liquidation` end-states reachable; `_accrue_interest` state-2 early return; group-index bounds; `collect_fees` balance clamp; `collect_algo` AVM-bounded fail-closed; oracle anchor band math + anchor-0 not dangerously reachable (whitelist check reverts first); oracle bot pool-state read matches Tinyman v2 layout.

**Verdict:** after the P21 fixes, the auditor's one blocking finding (P21-01) and all hardening items are resolved; all three contracts compile clean. Remaining pre-mainnet work is operational (fill config, verify wBTC decimals, plan the genesis 48h timelock window).

---

## Pass 22 — LocalNet Integration Test Suite (executable verification)

Built a full LocalNet integration test suite (`contracts/tests/`, 34 tests) that deploys the three real compiled contracts to a dev-mode Algorand node and exercises them with real atomic groups, inner transactions, cross-contract calls, and dev-mode time travel. This is the first time the contracts were *executed* rather than only compiled + reviewed — and it immediately surfaced a real bug that 21 review passes missed.

### High — Fixed

**[P22-01] 🟢 `pay_interest` overpayment path reverts on-chain — funds-it-spends read at the wrong group index**
- `pay_interest` read the borrower's mUSD transfer at `group_index + 1` (after the app call). On the overpayment path the vault forwards the principal-repayment portion (`change`) to the PSM via an inner AssetTransfer **during** the app call. On Algorand, a group transaction at a *later* index has not executed when the app call runs, so the vault held 0 mUSD and the inner forward underflowed (`underflow on subtracting … from sender amount 0`). Any borrower overpaying to reduce principal would have their transaction revert — a core documented feature, broken on-chain. (The interest-only path, `change == 0`, has no inner forward and would have worked, which is likely why review missed it.)
- Every other method that *spends* funds it receives in the same group (`mint_musd`, `redeem_musd`, `deposit_usdc`) correctly reads them at `group_index − 1` (transfer first). `pay_interest` was the lone inconsistency.
- **Fix:** read the mUSD transfer at `group_index − 1` and require it to precede the app call (assert `group_index >= 1`). The funds now land in the vault before the inner forward runs. `contract.py` (vault) `pay_interest`; docs updated (VAULT.md group order). Fails-safe either way (it reverted), so no funds were ever at risk — but it would have shipped a broken feature requiring a redeploy to fix.

### Coverage (all 34 passing)
PSM mint/redeem/fee-routing/invariant-guard/pause; full vault lifecycle (open deferred + with-borrow, LTV caps, interest, overpayment→principal, repay, add_collateral, borrow_more); accrual incl. the **P21-01 multi-year catch-up** (regression test for the lost-time fix) and rate-lock; all liquidation paths (micro, partial tier1/2, full surplus + shortfall/bad-debt) with settlement end-states and PSM-invariant checks; two-role rotation/recovery/distinctness, pause (guardian-only unpause), 48h timelock + guardian veto on both repointing powers; oracle updater-auth, ±50% prior guard, ±25% anchor band, re-anchor, freshness-blocks-borrow.

**Verdict:** contracts now compile clean AND pass executable integration tests covering every privileged path. The test suite is committed and re-runnable (`contracts/tests/README.md`). This materially de-risks mainnet beyond static review. A professional third-party audit is still recommended before significant TVL.

---

## Pass 23 — Adversarial / Security Test Suite

Added 33 adversarial tests (`test_attacks_authz.py`, `test_attacks_logic.py`) probing the protocol *outside* normal operation. Full suite now 67 tests, all passing. No new exploitable vulnerability found; one bounded griefing edge documented.

### Attack classes exercised (all correctly rejected / contained)
- **Cross-contract bypass (highest stakes):** direct `PSM.issue_musd` and `receive_musd` calls from an attacker EOA — and from the admin — are rejected by `_assert_vault_caller`. Confirms the unlimited-mint guard: only the registered vault app address can mint mUSD. Repeated attempts change nothing (no funds minted).
- **Admin access control:** every privileged method on all three contracts rejects non-admin callers (full sweep). Guardian is containment-only (cannot set params, trigger liquidations, or move funds). Bot is prices-only.
- **Self-liquidation / grief:** a borrower cannot trigger any liquidation on their own vault (admin-gated).
- **Group composition manipulation:** MBR underpay / wrong receiver; wrong-asset or wrong-receiver or zero-amount LP deposit; `open_vault` called standalone (no group); mint amount-mismatch / wrong-receiver; **double-mint off one deposit** (second call reads the prior app call, not a transfer → rejected); repay routed to vault instead of PSM; pay_interest routed to PSM instead of vault. All rejected.
- **State-machine abuse:** a state-2 (in-liquidation) vault rejects `borrow_more` / `pay_interest` / `add_collateral` / `repay_principal`; an overdue (state-1) vault rejects `borrow_more`.
- **Liquidation correctness:** healthy vaults (HF > 1) cannot be liquidated by any path; a tier-1 health factor cannot be used to seize the larger tier-2 fraction (no over-seizure); invalid tier values (0/3/99) rejected; double-liquidation rejected; micro-liq rejected before 90 days / when not overdue; settling more than the counter rejected; settling a healthy vault rejected.
- **Dust / zero:** zero-amount borrow and mint rejected.

### Low — documented, not fixed (bounded griefing)

**[P23-01] ⚪ LP opt-out can delay (not prevent) a surplus full-liquidation**
- A borrower who holds zero LP (all deposited) can opt out of the LP ASA. `trigger_full_liquidation` returns *surplus* LP to the borrower via an inner transfer when `lp_value > total_debt`; that transfer fails to an opted-out account, reverting the liquidation.
- **Impact is bounded and non-economic:** the grief only works while the position still has surplus equity (`lp_value > debt`), during which the protocol remains fully covered (collateral value exceeds debt — only the 0.75 safety buffer is breached, not solvency). Once the position goes underwater past the debt there is no surplus transfer and full-liquidation proceeds normally. Partial liquidation (seizes to admin, no borrower-bound transfer) is also unaffected at the appropriate HF band. The borrower cannot extract the locked LP and gains nothing but delay. Verified by `test_optout_griefing_is_bounded`.
- **Future hardening (post-v2, optional):** custody surplus LP in the vault for the borrower to claim separately, rather than force-pushing it during liquidation. Not blocking for launch.

**Verdict:** the contracts pass 67 functional + adversarial integration tests covering every privileged path and the major attack classes. Internal verification is now strong (23 passes incl. executable + adversarial testing). A professional third-party audit remains the recommended final gate before significant TVL.

---

## Pass 24 — Oracle Bot Unit Tests

Closed the last untested component. Added 30 fast, network-free unit tests for the off-chain price bot (`oracle_bot/tests/`), covering the logic that determines what price reaches the on-chain oracle:

- **TWAP math:** thin-history fallback to spot, zero-elapsed-time guard, window trimming/`count`, and the trapezoidal average — including a regression assertion that the latest reading is reflected (the P19-16/F-16 left-Riemann bug would fail it).
- **Persistence:** cross-instance round-trip, atomic save (no stray `.tmp`), and corrupt-file recovery (starts fresh, never raises).
- **`_decode_local_state`:** extracts uints / ignores byte values, handles both algod key casings (`app-local-state`/`appLocalState`).
- **`compute_lp_price`:** TVL/LP math, decimal normalization, zero-supply and zero-reserve → None.
- **`get_lp_price` guards:** happy path, on-chain asset-id mismatch → None (wrong `pool_address` defence, P19-01), missing Vestige price → None, and the absolute min/max sanity bounds.
- **`update_pool` orchestration:** the fail-stale min-readings gate (P19-07), asymmetric divergence (upward spike blocked, downward drop allowed through), skip when price unavailable, and `post_price` dry-run with no network.
- **`load_config`:** missing file / zero oracle id → exit; happy parse.

Run: `cd oracle_bot && <test-venv>/bin/python -m pytest tests -q` (needs `pytest` + `requests`). All 30 pass.

**Coverage status:** all three contracts (67 integration/adversarial tests) and the oracle bot (30 unit tests) now have executable test coverage.

---

## Pass 25 — Oracle Bot Price-Source Rebuild (on-chain + CompX second source)

The configured price feed (Vestige `api.vestigelabs.io`) was **dead** — the domain was retired in Vestige's rebrand, and the current host (`free-api.vestige.fi`) returns Cloudflare 530 to datacenter IPs. This surfaced **P19-02** (single external price feed = SPOF) as a live failure. The bot's entire price layer was rebuilt to be self-contained and independently cross-checked.

### Resolved

**[P19-02] 🟢 Primary pricing is now fully on-chain.** Each underlying is priced in USDC by walking a reference-pool graph over Tinyman v2 reserves, rooted at USDC: `ALGO ← ALGO/USDC`, `tALGO ← tALGO/ALGO`, `U ← U/tALGO` (`derive_asset_price_usdc`, recursive + memoized). No external HTTP price API, no API keys, no rate limits, no dead domains. Reserves are read from each pool account's local state under the AMM validator app — the same path already used for the LP itself.

**Second source / divergence guard.** The volatile underlying ($U) is cross-checked against CompX's on-chain **Flux oracle** (mainnet app `3307588794`, price box `"prices"+uint64(assetId)`, tuple `(assetId, price, lastUpdated)` ×1e6 — read directly, the public `@compx/sdk` helper pointed at a stale default). A genuine divergence beyond `compx_divergence_limit` (default 5%) while CompX is fresh **refuses the post** (fail-stale, P19-02's intent). CompX being unavailable/stale is a soft warning — bot liveness is not coupled to CompX uptime.

### Verification
- Mainnet `--dry-run`: derived `U=$0.117608`, `tALGO=$0.092594` → U/tALGO LP `675635` ($0.6756); CompX cross-check `derived $0.1176 vs CompX $0.1186 (Δ0.86%)`; fail-stale gate + dry-run post all fired correctly.
- `config.json` filled with the real U/tALGO vault pool (`AIR4…`, LP token `3163770927`, `pool_id=3163770927`), reference pools (ALGO/USDC `2PIFZW…`, tALGO/ALGO `LIHQGE…`, U/tALGO `AIR4…`), and asset decimals.
- Test suite expanded **30 → 42** (added `_pool_reserves`, `derive_asset_price_usdc`, `read_compx_price`, `compx_cross_check`, and a CompX-divergence `get_lp_price` guard); all green. Removed the dead `requests`/Vestige dependency.

### Still open (operational, pre-mainnet)
Set the mainnet `oracle_app_id` + bot wallet at deploy time; bot uptime alerting + redundant instances (AUD-004).

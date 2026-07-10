# MagnetFi v2 — Admin Operations

## Trust Model

MagnetFi v2 is an admin-managed protocol with a **two-role security model**. Bazooka Labs holds operational authority through a *hot admin* key for day-to-day operations, backed by a *cold guardian* key that exists solely to contain a compromise of the hot key. There is no on-chain governance at launch.

This is a deliberate choice. Trustless governance adds complexity and attack surface. The admin-managed model is appropriate for a protocol at this stage and scale — and the guardian split means a single hot-key compromise cannot drain the protocol.

### Roles

| Role | Key type | Powers |
|---|---|---|
| **Admin** (hot) | Hardware wallet | Rates/LTV/thresholds, all liquidations, fee/reserve management, oracle-bot authorization, price re-anchoring, opt-ins, *proposing* the timelocked oracle/vault repoints, pause |
| **Guardian** (cold) | Cold multisig | Pause **and** unpause, **cancel** any queued timelocked change (the veto), and propose admin rotation (recovery). Never signs routine transactions. |

**What the admin can do:**
- Trigger all liquidations; set rates / LTV / thresholds; manage PSM reserves; collect revenue
- Authorize/rotate the oracle bot key; re-anchor oracle prices
- *Propose* (not instantly execute) oracle/vault-contract repoints — these are timelocked 48h
- Pause new borrowing / minting

**What the admin canNOT do (contract-enforced):**
- Withdraw PSM USDC below total circulating mUSD
- Trigger micro-liquidation before 90 days of non-payment
- Post prices with >50% deviation from prior, or >±25% from the admin anchor (oracle guards)
- Set rates above 3000 bps (30% APR)
- **Instantly** repoint the LP oracle or the registered vault contract — these wait out a 48h timelock during which the guardian can cancel
- **Unpause** after the guardian has paused (only the guardian can lift a guardian-set lock)

### Catastrophic-power containment

The two highest-leverage powers — repointing the LP oracle (→ fake prices → over-borrow) and repointing the registered vault on the PSM (→ unauthorized mUSD minting) — are **timelocked 48h** and **guardian-cancellable**. If the hot key is compromised and the attacker queues a malicious repoint, the cold guardian cancels it during the delay window and rotates the admin. This is the core reason a single-key compromise is survivable.

---

## Admin Wallet (hot)

| Property | Recommendation |
|---|---|
| Wallet type | Hardware wallet (Ledger) |
| Key person | Founder (Bazooka Labs) |
| Operations frequency | Quarterly (fee collection + rate review) + on-demand (liquidations) |
| Backup | Cold backup of seed phrase in secure offline location |
| USDC float | Keep ~$500 USDC in admin wallet at all times |
| Rotation | 2-step: `propose_admin(new)` then new key calls `accept_admin()`. Guardian may also propose (recovery). |

**USDC float rationale:** when a health-factor liquidation is triggered, LP collateral is seized immediately but selling it takes time. Keeping $500 USDC in the admin wallet allows instant settlement — use the float to buy mUSD from the PSM and close the vault in the same session. The seized LP can then be sold at the admin's discretion, at favorable market conditions rather than under distress.

The admin is stored on-chain (mutable via 2-step rotation) on all three contracts; it is initialized to the deployer at creation. Seized LP and swept fees/ALGO route to the *current* admin.

---

## Guardian Wallet (cold)

Separate **cold multisig**, ideally 2-of-3 across hardware wallets held by different principals. Touched only during incidents or scheduled rotations — never for routine operations.

| Property | Recommendation |
|---|---|
| Wallet type | Cold multisig (2-of-3 hardware) |
| Powers | `pause`/`unpause`, `cancel_pending_*` (veto a queued repoint), `propose_admin` (recovery), `propose_guardian`/`accept_guardian` (rotate itself) |
| Storage | Fully offline; signing only for incident response |
| Compromise impact | Guardian alone cannot move funds or change parameters — it can only pause and veto. A guardian compromise is a griefing risk (can pause), not a drain risk. |

**Incident playbook (suspected hot-key compromise):** (1) guardian `pause` to halt new borrowing/minting; (2) guardian `cancel_pending_lp_oracle` / `cancel_pending_vault_contract` if anything is queued; (3) guardian `propose_admin(clean_key)`, then the clean key `accept_admin()`; (4) rotate the oracle bot key via the new admin if needed; (5) guardian `unpause` once clean.

---

## Oracle Bot Wallet

Separate hot wallet authorized only to post LP prices. Separate from both admin and guardian.

| Property | Value |
|---|---|
| Permissions | `update_lp_price()` only across LP oracle contract |
| Storage | Server environment variable (encrypted); never in shell history |
| Operations frequency | Every 5 minutes (automated) |
| Compromise impact | **Bounded price movement, not unbounded.** A compromised bot can move price only within ±50% of the prior post AND ±25% of the admin anchor before it needs the admin to re-anchor (which a compromised bot cannot do). Worst case is bounded mispricing + staleness, not arbitrary drift. Rotate via `set_authorized_updater()`. |

---

## Admin Actions by Contract

### LP Oracle Contract

| Action | Method | Frequency | Notes |
|---|---|---|---|
| Register bot wallet | `set_authorized_updater(address)` | Once at deploy; if bot key rotated | Required before prices can post |
| Add supported LP pool | `add_pool(pool_id, initial_price)` | When new vault type added | Also update bot to price new pool |
| Remove LP pool | `remove_pool(pool_id)` | If a pool is deprecated | Existing vaults must close first |
| Emergency price override | Not available — bot only | — | Contract guard is the safety mechanism |

---

### PSM Contract

| Action | Method | Frequency | Notes |
|---|---|---|---|
| Capitalize PSM | `deposit_usdc(amount)` | Initial deploy + as needed | Opens vault ceiling; direct deposit to PSM address |
| Withdraw excess reserves | `withdraw_usdc(amount)` | Rare; admin discretion | Contract guard: cannot reduce below circulating mUSD |
| Adjust redemption fee | `set_redeem_fee(fee_bps)` | Rarely | Applies to mUSD → USDC only; default 100 bps (1%); max 500 bps; USDC → mUSD is always 0% |
| Register vault contract | `propose_vault_contract(vault_app_id)` → wait 48h → `confirm_vault_contract()` | At deploy; if vault redeployed | **Timelocked 48h.** Guardian can `cancel_pending_vault_contract()`. PSM only accepts issue/receive calls from the registered vault. |
| Pause / unpause mint | `pause()` / `unpause()` | Incident only | `pause` halts public `mint_musd` (redeem stays open). Either role pauses; **guardian only** unpauses. |

**PSM withdrawal procedure:**
1. Check `psm.usdc_balance − circulating_musd` = available excess
2. Call `withdraw_usdc(amount)` where `amount ≤ excess`
3. Verify vault ceiling after withdrawal; alert if it drops below existing borrow demand

**Productive reserves (v3) — new admin actions (see [PSM.md](./PSM.md#productive-reserves-v3)):**
| Action | Method | Notes |
|---|---|---|
| Deploy reserve to a venue | `deploy(adapter, amount)` | Routes idle USDC to a whitelisted adapter (Folks first); contract refuses to breach the liquidity buffer / per-venue cap |
| Recall reserve | `recall(adapter, amount)` | Pulls USDC back to the on-chain buffer |
| Harvest yield | `harvest(adapter)` | Sweeps accrued yield to treasury |
| Add / remove an adapter | `propose_adapter` → 48h → `confirm_adapter` / `cancel_adapter` | Timelocked + guardian-vetoable; ≤5 adapters; manages the strategy portfolio without a migration |

Monitoring adds: buffer coverage (on-chain USDC vs expected redemption flow), per-adapter recoverable value + venue health, and total-deployed ≤ reserve − buffer.

---

### Vault Contract

#### Rate Management

| Action | Method | Notes |
|---|---|---|
| Set interest rate | `set_rate(pool_id, rate_bps)` | Per vault type; max 3000 bps (30% APR) |
| Set LTV | `set_ltv(pool_id, ltv_bps)` | Lower LTV = less borrowing capacity; affects new borrows only. Set `set_liq_threshold` first. |
| Set liquidation threshold | `set_liq_threshold(pool_id, bps)` | Cannot be lower than LTV (would allow instant liquidation) |
| Update LP oracle reference | `propose_lp_oracle(new_app_id)` → wait 48h → `confirm_lp_oracle()` | **Timelocked 48h.** Guardian can `cancel_pending_lp_oracle()`. Only if oracle redeployed. |
| Advance accrual | `advance_accrual(borrower, pool_id)` | Catch up interest on a multi-year-abandoned vault (1yr cap per call); call repeatedly before liquidating |
| Pause / unpause borrowing | `pause()` / `unpause()` | Incident only | `pause` halts `open_vault` (with borrow) and `borrow_more`; repay/liquidate/settle stay open. Either role pauses; **guardian only** unpauses. |

**Rate change note:** rate changes take effect on next accrual event per position. Borrowers are not notified on-chain. The frontend must display the current rate and alert borrowers when rates change.

**Oracle re-anchoring note:** the LP oracle bounds posted prices to ±25% of an admin anchor. During a genuine large price move, call `set_price_anchor(pool_id, new_anchor)` (LP Oracle, admin) to follow it; otherwise the bot's posts will be rejected once they hit the band edge. This manual step is the cumulative-drift backstop a compromised bot cannot perform.

#### Liquidations

**Micro-Liquidation Procedure:**
1. Monitor `last_payment_timestamp` for all active vaults (off-chain indexer scan)
2. Flag any vault where `current_time − last_payment_timestamp > 90 days`
3. Attempt to contact borrower (operational, not on-chain)
4. If no response: call `trigger_micro_liquidation(borrower_address, pool_id)` from admin wallet
5. Receive seized LP tokens in admin wallet (covers accrued interest + 5% buffer)
6. Redeem LP on Tinyman (two assets received)
7. Record as protocol revenue; 3% late fee portion is pure revenue above cost recovery

**Health-Factor Liquidation Procedure (Tiered):**

| HF Range | Admin Action | Expected Outcome |
|---|---|---|
| 0.95 – 0.9999 | `trigger_partial_liquidation(borrower, pool_id, tier=1)` | Seize 35% LP → health restored; position continues |
| 0.85 – 0.9499 | `trigger_partial_liquidation(borrower, pool_id, tier=2)` | Seize 60% LP → health restored; position continues |
| < 0.85 | `trigger_full_liquidation(borrower, pool_id)` | Seize 100% LP → position closed |

**Partial liquidation steps (Tier 1 or Tier 2):**
1. Monitor health factors; flag any vault where `health_factor < 1.0`
2. Identify which tier the position falls in
3. Call `trigger_partial_liquidation(borrower_address, pool_id, tier)` — contract asserts HF is in tier's range
4. Receive seized LP tokens in admin wallet
5. Use USDC float (~$500) to immediately buy mUSD from PSM (0% fee)
6. Call `settle_health_liquidation(borrower_address, pool_id, musd_amount)` in an **atomic group with `AssetTransfer(mUSD → PSM contract address, amount = musd_amount)`** — vault asserts this transfer is present; omitting it causes the transaction to revert
7. Sell seized LP at admin's discretion; replenish USDC float from proceeds

**Full liquidation steps (Tier 3):**
1. Call `trigger_full_liquidation(borrower_address, pool_id)` — contract asserts HF < 0.85
2. Receive all LP tokens; any surplus LP above debt is returned to borrower by contract
3. If LP value ≥ total debt: use USDC float to buy full `musd_to_settle`, call `settle_health_liquidation(borrower_address, pool_id, musd_to_settle)` in an atomic group with `AssetTransfer(mUSD → PSM address)`
4. If LP value < total debt (shortfall): buy and settle only `musd_to_settle` mUSD (= lp_value, the contract's settlement counter) via `settle_health_liquidation(borrower_address, pool_id, musd_to_settle)` in an atomic group with `AssetTransfer(mUSD → PSM address, amount = musd_to_settle)` — the contract asserts `musd_amount ≤ accrued_interest = musd_to_settle`; passing `total_debt` fails this assertion. The PSM invariant is not broken by the shortfall — PSM USDC was reserved at vault open time. Optionally call `deposit_usdc(total_debt − musd_to_settle)` after settlement to restore vault ceiling headroom; this is discretionary, not an invariant requirement.
5. Vault box is deleted; MBR returned to borrower; position closed
6. After settlement: sell seized LP to replenish USDC float; ensure float is restored to ~$500 before next liquidation

**Settlement is incremental:** `settle_health_liquidation()` accepts partial amounts and decrements the settlement counter. If the USDC float is insufficient to cover a large liquidation in one call, the admin may settle in multiple transactions as more USDC is freed up from LP sales.

**Health factor monitoring cadence:** check all active vaults on every oracle price update (every 5 minutes). A position can breach health factor between oracle updates — the more frequently health factors are recomputed, the smaller the potential shortfall.

#### Fee Collection

| Action | Method | Destination |
|---|---|---|
| Collect loan interest | `collect_fees()` | Loan interest accumulates as mUSD in vault; swept to treasury when admin is ready |
| Collect contract ALGO | `collect_algo()` | Vault holds ALGO from MBR accumulation; sweep excess above minimum reserve |

**Loan interest collection flow:**
- Loan interest is paid by borrowers as mUSD on each quarterly payment
- All interest accumulates in the vault contract's `accumulated_fees` counter
- Admin calls `collect_fees()` to sweep accumulated mUSD to treasury wallet
- Swept mUSD is live circulating mUSD. To reduce circulating supply and grow the vault ceiling, admin sends the mUSD directly to the PSM contract address via a plain AssetTransfer — no method call required; PSM tracks its actual mUSD ASA balance, so the balance (and thus the vault ceiling) updates automatically upon receipt.

---

## Revenue Accounting

| Source | Asset | Route |
|---|---|---|
| PSM redemption fees (1% on mUSD → USDC) | USDC | Routed directly to treasury wallet per transaction (not retained in PSM) |
| Vault loan interest (protocol portion) | mUSD | Accumulated in vault contract; swept by admin to treasury when ready |
| Micro-liquidation seized LP | LP tokens (→ underlying assets) | Admin redeems on Tinyman; keeps as revenue |
| Health-liq surplus collateral | LP tokens / underlying | Admin wallet after seizure and settlement; sell at admin's discretion |

PSM redemption fees route to treasury automatically per transaction. All other revenue requires an admin sweep or redemption action.

---

## Monitoring Checklist

The admin (or an automated monitoring script) should track:

| Metric | Threshold | Action |
|---|---|---|
| Oracle bot last update | >10 min stale | Alert; investigate bot; restart if needed |
| Any vault: `current_time - last_payment_timestamp` | >75 days | Flag; begin borrower outreach |
| Any vault: `current_time - last_payment_timestamp` | >90 days | Eligible for micro-liq; admin discretion on timing |
| Any vault: health factor | <1.2 | Watch closely; compute HF with every oracle update |
| Any vault: health factor | <1.0 | Eligible for health liquidation; act promptly |
| Any vault: vault_state == 2 for >1 hour | — | Alert; admin must complete settlement or fund USDC float |
| Admin wallet: USDC float | <$200 | Replenish from LP proceeds before next liquidation |
| PSM: overcollateralization ratio | <1.05 | Alert; consider admin USDC deposit |
| PSM: vault ceiling | <10% of total outstanding | Alert; add reserves or tighten LTV |
| Contract ALGO balances | <1 ALGO each | Top up |

---

## Deployment Procedure (v2)

Order matters — do not skip steps or reorder.

### Pre-Deploy
- [ ] Create mUSD ASA (admin wallet in Pera): name "Magnet USD", unit "mUSD", 6 decimals, 500M supply, freeze=zero, clawback=zero
- [ ] Note mUSD ASA ID; set `musd` in `DEPLOYMENTS.mainnet` in `web/src/lib/magnetfi.ts` (mUSD already live: `3615600399`)
- [ ] Create oracle bot wallet (separate hot key); fund with ALGO for transaction fees (~5 ALGO)
- [ ] **Create the guardian wallet** — a cold multisig (recommend 2-of-3 hardware), separate from the admin and bot keys. Record its address; it is passed to all three `deploy()` calls.
- [ ] **Verify wBTC ASA decimal count on Algorand mainnet** — actual decimals must match the value hardcoded in the oracle bot decimal config table (AUD-006)
- [ ] **Confirm Tinyman v2 pool account address + AMM validator app id** for each pool (the bot reads reserves from the pool account's LOCAL state — see P19-01). Set `pool_address` and `amm_validator_app_id` in `oracle_bot/config.json`.
- [ ] Prepare initial risk parameter values for all supported pool types: `rate_bps`, `ltv_bps`, `liq_threshold_bps`, `lp_asa_id` per pool (confirm `liq_threshold_bps > ltv_bps` for each pool before deploying)
- [ ] Confirm initial oracle prices for each pool (used as `initial_price` to `add_pool()` — sets both the live price and the ±25% anchor)

### Deploy Contracts (admin wallet, via deploy wizard or script)
- [ ] Deploy LP Oracle: `deploy(guardian)`; record App ID
- [ ] Deploy PSM: `deploy(musd_asa_id, usdc_asa_id, guardian)`; record App ID
- [ ] Deploy Vault: `deploy(psm_app_id, lp_oracle_app_id, musd_asa_id, usdc_asa_id, guardian)`; record App ID
- [ ] The deployer becomes `admin` on each; the passed address becomes `guardian`. Verify both on each contract.
- [ ] Set the oracle / PSM / vault app IDs (plus LP + pool IDs) in `DEPLOYMENTS.mainnet` in `web/src/lib/magnetfi.ts`

### Initialize LP Oracle
- [ ] Call `set_authorized_updater(bot_wallet_address)`
- [ ] For each supported pool: call `add_pool(pool_id, initial_price)` — sets live price AND the ±25% drift anchor (AUD-043 / P19-03)
- [ ] Verify price and timestamp stored for each pool; confirm `lp_price_[pool_id] > 0`

### Initialize PSM
- [ ] Call `opt_in_asset(musd_asa_id)` — PSM contract account opts into mUSD; required before any mUSD can be received
- [ ] Call `opt_in_asset(usdc_asa_id)` — PSM contract account opts into USDC; required before any USDC can be received
- [ ] Call `set_treasury(treasury_wallet_address)` — must be set before first redemption or redemptions will revert
- [ ] Verify `redeem_fee_bps` is at desired initial value (default: 100 bps = 1%)
- [ ] Transfer initial mUSD supply (500M × 10^6 base units) to PSM contract address — PSM becomes sole reserve holder

### Initialize Vault
- [ ] Call `opt_in_asset(musd_asa_id)` — vault contract account opts into mUSD; required to receive interest payments and issue `collect_fees` transfers
- [ ] For each supported pool, call `opt_in_asset(lp_asa_id)` — vault must opt into each LP token before `open_vault` can receive deposits for that pool
- [ ] On PSM: `propose_vault_contract(vault_app_id)`, **wait out the 48h timelock**, then `confirm_vault_contract()` — authorizes vault to call issue_musd / receive_musd. (At genesis the timelock is unavoidable; plan the 48h gap before public launch, or deploy the vault first so the window overlaps other setup.)
- [ ] For each supported pool, set initial risk parameters in this exact order:
  - `set_rate(pool_id, rate_bps)` — e.g., 500 for U/USDC (5%), 800 for others (8%)
  - `set_liq_threshold(pool_id, threshold_bps)` — **must come before set_ltv**; e.g., 7500 (75%) for all pools
  - `set_ltv(pool_id, ltv_bps)` — e.g., 6500 for U/USDC (65%), 6000 for others (60%); contract asserts ltv < liq_threshold, so liq must be set first
  - `set_lp_asa_id(pool_id, lp_asa_id)` — LP token ASA ID for each pool (used in add_collateral verification)
- [ ] Verify all parameters: confirm `liq_threshold_bps > ltv_bps` for every pool after setting

### Capitalize and Launch
- [ ] Admin deposits initial USDC into PSM via `deposit_usdc()` — this opens the vault ceiling
- [ ] Verify vault ceiling = deposited USDC amount (ceiling = psm_usdc_balance − circulating_musd = deposit − 0)
- [ ] Start oracle bot: `LP_ORACLE_APP_ID=... BOT_MNEMONIC=... python3 lp_oracle_bot.py`
- [ ] Verify first bot price update posts successfully for each pool; compare posted price against initial_price set at add_pool() — verify within 50% deviation band
- [ ] Check oracle freshness; confirm vault accepts oracle for borrows
- [ ] Redeploy site with updated contract IDs
- [ ] Perform a test borrow (small amount, single vault) to verify the full end-to-end flow before opening to public
- [ ] Open protocol to borrowers

---

## Emergency Procedures

**Oracle bot down (>freshness window):**
- **All liquidations are blocked** — both micro-liquidations and health-factor liquidations require oracle freshness; `trigger_micro_liquidation()` uses the oracle price to compute how many LP tokens to seize; without a fresh price, the amount cannot be determined safely
- New borrows are also blocked (vault rejects stale oracle)
- Existing positions continue accruing interest
- Repayments, interest payments, and collateral additions remain open (oracle not required for these)
- Action: restart bot immediately; if bot infrastructure is compromised, deploy replacement with new wallet and call `set_authorized_updater()`
- **Post-restart freshness gap (Pass 26/27):** after a >30-min outage the bot needs ~3 fresh readings (~15 min at the 5-min poll) to refill the TWAP window before it posts again; borrows and liquidations stay blocked during that window. Fail-safe, but liquidators must wait for the first post after recovery.
- **CompX second-source monitoring:** the bot cross-checks $U against CompX's Flux oracle (`3307588794`). If CompX goes stale/unavailable, the bot restricts to flat / ≤10%-decline posts and refuses any increase — a *bounded* fail-stale, hard-capped at −25% by the on-chain anchor. Monitor CompX freshness and re-anchor discipline, and run a redundant bot instance before scaling TVL (AUD-004).

**PSM reserve critically low:**
- If PSM USDC balance approaches circulating mUSD, vault ceiling approaches zero
- Admin deposits additional USDC into PSM to restore headroom
- If PSM USDC balance < circulating mUSD (should be impossible due to contract guard): protocol emergency; halt new activity and investigate

**Large position approaching health breach:**
- Begin monitoring more frequently
- Contact borrower if known
- If health factor crosses 1.0: trigger `trigger_partial_liquidation()` or `trigger_full_liquidation()` (per tier) promptly to minimize potential shortfall
- LP redemption should happen in the same session (same day) as seizure to minimize price exposure

**Admin (hot key) compromised:** — follow the guardian incident playbook (see Guardian Wallet section)
1. Guardian `pause()` on Vault and PSM to halt new borrowing / minting
2. Guardian `cancel_pending_lp_oracle()` (Vault) and `cancel_pending_vault_contract()` (PSM) if any timelocked repoint is queued
3. Guardian `propose_admin(clean_key)` on all three contracts; the clean key calls `accept_admin()` on each (this also auto-clears any pending repoint)
4. Rotate the oracle bot key via the new admin (`set_authorized_updater`) if it shares infrastructure
5. Guardian `unpause()` once clean
- The hot key alone cannot drain funds: the catastrophic oracle/vault repoints are timelocked 48h and guardian-cancellable, and the guardian holds unpause. Hardware wallet for the hot key further reduces compromise risk.

**Guardian (cold key) compromised:** — lower severity; the guardian cannot move funds or change parameters, only pause and veto
- A compromised guardian can grief by pausing (admin cannot unpause). Mitigation: admin `propose_guardian(clean_cold_key)` is not available (guardian-only) — so recovery requires the guardian's own `propose_guardian`/`accept_guardian`. **Therefore the guardian must be a robust cold multisig (2-of-3) so a single signer compromise does not lose the role.** This is why the guardian is specified as a multisig, not a single key.

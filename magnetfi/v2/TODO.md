# MagnetFi v2 — Open Items / Pre-Mainnet TODO

Compiled from all audit passes (1–21). This tracks what remains **open**; every audit
finding that required a *code* change is already resolved and recorded in [AUDIT.md](./AUDIT.md).
The three contracts compile clean and have been through three independent fresh-context
reviews (Passes 18, 19, 21) on the final architecture.

_Last updated: 2026-06-22. First vault target: **U/tALGO** on mainnet._

---

## 🔴 Blocking — must be done before mainnet launch

### Keys & assets
- [ ] Create the **guardian cold multisig** (recommend 2-of-3 hardware), distinct from the admin and oracle-bot keys. Its address is a required parameter to all three `deploy()` calls. The contract rejects `guardian == admin`.
- [ ] Create the **oracle bot wallet** (separate hot key); fund with ~5 ALGO for fees.
- [x] Create **mUSD ASA** on mainnet — ✅ **ASA `3615600399`** (Magnet USD / mUSD, 6 dp, 500M, default-frozen off, freeze + clawback renounced, manager/creator = `KNML…NYU6A`). Created via the admin-panel Pera handshake; verified on-chain. Wired into `web/src/lib/magnetfi.ts` (`MUSD_ASA_ID`).
- [ ] Gather first-vault (U/tALGO) mainnet IDs:
  - [ ] tALGO ASA ID
  - [ ] U/tALGO **Tinyman v2 pool ACCOUNT address** (the bot reads reserves from the pool account's *local* state — not a per-pool app)
  - [ ] U/tALGO **LP token ASA ID** (used for `set_lp_asa_id` and vault deposit checks)
  - [ ] Confirm AMM validator app id = `1002541853` (mainnet)

### Oracle bot config (`oracle_bot/config.json` ships as a template — fill before starting)
- [ ] Set `oracle_app_id` and `amm_validator_app_id`
- [ ] For **each** pool: real `pool_address`, **distinct** `pool_id`, correct `asset_a_id`/`asset_b_id` and decimals
- [ ] Set non-zero `min_price`/`max_price` absolute sanity bounds per pool (0 = disabled; leaving them 0 removes the absolute-bound backstop)
- [ ] **(If/when a wBTC pool is added)** verify wBTC ASA decimal count on mainnet matches config — long-standing AUD-006 flag. Not required for the U/tALGO launch.

### Deployment sequencing
- [ ] Follow the [ADMIN.md deployment procedure](./ADMIN.md#deployment-procedure-v2) exactly (order matters).
- [ ] **Plan the genesis 48h timelock window:** registering the vault on the PSM is now `propose_vault_contract` → wait 48h → `confirm_vault_contract`. Schedule this gap before public launch (e.g., run it during the rest of setup).
- [ ] Confirm initial oracle prices for each pool — passed to `add_pool(pool_id, initial_price)`, which sets both the live price and the ±25% drift anchor.
- [ ] Prepare risk params per pool: `rate_bps`, `liq_threshold_bps` (set **before** `set_ltv`), `ltv_bps`, `lp_asa_id`.

---

## 🟠 Strongly recommended before mainnet (not code-blocking)

- [x] **Automated test suite.** ✅ Done — LocalNet integration suite at `contracts/tests/` (34 tests), deploying the real compiled contracts and exercising every privileged path: full lifecycle, all liquidation paths + settlement end-states, two-role/pause/timelock flows, oracle guards, and the P21-01 multi-year catch-up regression. Caught a real bug on first run (P22-01, fixed). Re-run with `.venv-test/bin/python -m pytest tests/` (see `tests/README.md`).
- [ ] **Professional third-party audit** before significant TVL. Internal review is strong (22 passes + executable tests), but real-fund custody warrants an external firm.
- [ ] **Test borrow on mainnet** with a small amount (single vault, full open→borrow→repay) before opening to the public.

---

## 🟡 Deferred design items / future enhancements (non-blocking)

- [ ] **Multi-source oracle pricing (P19-02).** LP_ORACLE.md describes a 3-tier source hierarchy (Vestige direct LP price → computed from asset prices + reserves → full on-chain) with a cross-source median/divergence check. Only the computed (reserves × Vestige asset prices) path is implemented. Add a second independent source + median before scaling TVL, so a single bad feed can't propagate.
- [ ] **Bot redundancy & alerting (AUD-004).** Run redundant bot instances and uptime/staleness alerting so the oracle doesn't go stale on a single-host failure. (Oracle staleness fails safe — blocks borrows/liquidations — but is still an availability hit.)
- [ ] **Surplus-LP custody on liquidation (P23-01).** `trigger_full_liquidation` force-pushes surplus LP to the borrower; a borrower who opted out of the LP ASA can thereby delay (not prevent) a surplus liquidation. Bounded/non-economic (see AUDIT.md Pass 23). Optional future hardening: custody surplus for separate claim instead of force-pushing.
- [ ] **Multi-vault support.** PSM authorizes a single vault app id. If a second vault contract is ever deployed, extend the registration to a list.
- [ ] **PSM idle-reserve yield.** USDC held in the PSM earns nothing; a future version could deploy idle reserves into low-risk yield. Out of v2 scope.

---

## 🔵 Frontend / integration

- [ ] Update `web/src/lib/constants.ts` with deployed IDs: `LP_ORACLE_V2_APP_ID`, `PSM_APP_ID`, `VAULT_APP_ID`, `MUSD_ASA_ID`.
- [ ] Frontend must construct the correct **atomic groups** — group ordering is enforced on-chain (e.g. `open_vault`: MBR payment at index−1, LP transfer at index+1; mUSD/USDC transfers adjacent to their app calls).
- [ ] Frontend must display the **current rate** and alert borrowers on rate changes (rate locks at vault open; changes apply only to new vaults).
- [ ] Surface **pending timelocked changes** and **pause state** on the admin dashboard (operators should cancel any stale pending repoint as part of every admin rotation — P21-04 auto-clears it on `accept_admin`, but visibility matters).
- [ ] Redeploy the site with updated contract IDs after deploy.

---

## 🟢 Post-launch monitoring (operational — see [ADMIN.md](./ADMIN.md#monitoring-checklist))

- [ ] Oracle bot freshness (>10 min stale → alert)
- [ ] Per-vault health factor (<1.2 watch, <1.0 act) on every oracle update
- [ ] Payment-overdue tracking (>75 days flag, >90 days micro-liq eligible)
- [ ] PSM overcollateralization ratio (<1.05 alert) and vault ceiling headroom
- [ ] Vaults stuck in `vault_state == 2` for >1 hour (settlement incomplete)
- [ ] Admin USDC float (<$200 replenish) and contract ALGO balances (<1 ALGO top up)

---

## ✅ Resolved (reference only)

All code-level audit findings through Pass 21 are fixed and recorded in [AUDIT.md](./AUDIT.md), including:
the two-role guardian model (admin rotation, pause, 48h timelock on oracle/vault repointing),
the oracle ±25% drift anchor (P19-03), the oracle-bot pool-state read correction (P19-01),
the settlement-branch LP-trap fix (F-01), the accrual lost-time fix (P21-01), and role-distinctness
guards (P21-02/03/04). P19-04 was confirmed *not* a bug (liquidation interest is realized as PSM
overcollateralization, withdrawable via `withdraw_usdc`).
